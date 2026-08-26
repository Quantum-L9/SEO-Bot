/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Run-evidence store — assembles `l9.seo-bot-run-llm-audit/v1` across the three
 * build-intelligence endpoints.
 *
 * Website-Bot's build-intelligence run is ONE run spread over three HTTP calls
 * (competitive-landscape → seo-content-blueprint → structured-content). The run
 * id is derived from the run's own identity (`client_id` + `build_id`), so both
 * sides compute the same id without a handshake, and each leg merges its
 * measured evidence into that run's record.
 *
 * The store is deliberately in-process and bounded: it holds observability
 * evidence for the lifetime of a build, never product state. Eviction is
 * insertion-ordered and a miss is a 404 — an evicted run is reported as absent,
 * never reconstructed from defaults.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { DirectProviderBypassEvidence, LlmRunRecorder } from "../services/llm-run-recorder.js";
import { PRODUCER } from "./producer.js";
import {
  assertRunLlmAudit,
  RUN_LLM_AUDIT_SCHEMA,
  type RunLlmAuditV1,
  runIdFor,
} from "./run-llm-audit.js";
import type { SEOContentBlueprintEvidence } from "./seo-content-blueprint.js";
import type { StructuredContentEvidence } from "./structured-content.js";

/** How many runs the store retains before evicting the oldest. */
export const RUN_EVIDENCE_CAPACITY = 256;

interface RunRecord {
  run_id: string;
  /**
   * The consumer's own id for this run, when it supplied one. Website-Bot
   * correlates the audit against its own record of the same run by id, and it
   * mints that id — so SEO-Bot echoes it rather than asking the consumer to
   * recompute SEO-Bot's derived id.
   */
  run_ref: string | null;
  /** A leg that supplied a DIFFERENT run_ref than an earlier leg. */
  run_ref_conflicts: string[];
  client_id: string;
  build_id: string;
  first_seen_at: string;
  updated_at: string;
  legs: {
    competitive_landscape: boolean;
    seo_content_blueprint: boolean;
    structured_content: boolean;
  };
  ranking_llm_calls: number;
  blueprint?: SEOContentBlueprintEvidence;
  content?: StructuredContentEvidence;
  recorded: ReturnType<LlmRunRecorder["snapshot"]>;
}

function emptySnapshot(): RunRecord["recorded"] {
  return {
    operations: [],
    capability_rejections: [],
    direct_provider_bypasses: [],
    attribution_failures: [],
  };
}

const runs = new Map<string, RunRecord>();

function record(clientId: string, buildId: string, now: string, runRef?: string): RunRecord {
  const runId = runIdFor(clientId, buildId);
  const existing = runs.get(runId);
  if (existing) {
    existing.updated_at = now;
    applyRunRef(existing, runRef);
    return existing;
  }
  const created: RunRecord = {
    run_id: runId,
    run_ref: null,
    run_ref_conflicts: [],
    client_id: clientId,
    build_id: buildId,
    first_seen_at: now,
    updated_at: now,
    legs: {
      competitive_landscape: false,
      seo_content_blueprint: false,
      structured_content: false,
    },
    ranking_llm_calls: 0,
    recorded: emptySnapshot(),
  };
  applyRunRef(created, runRef);
  runs.set(runId, created);
  while (runs.size > RUN_EVIDENCE_CAPACITY) {
    const oldest = runs.keys().next();
    if (oldest.done) break;
    runs.delete(oldest.value);
  }
  return created;
}

/**
 * Bind the consumer's run reference to the run. The three legs are three HTTP
 * calls in one run, so they must agree: a second leg naming a different run is
 * recorded as a conflict and fails the audit rather than overwriting the first.
 */
function applyRunRef(target: RunRecord, runRef: string | undefined): void {
  const trimmed = runRef?.trim();
  if (!trimmed) return;
  if (target.run_ref === null) {
    target.run_ref = trimmed;
    return;
  }
  if (target.run_ref !== trimmed) {
    target.run_ref_conflicts.push(
      `leg supplied run_ref "${trimmed}" for a run already bound to "${target.run_ref}"`,
    );
  }
}

/** Merge a recorder's snapshot into a run, de-duplicating by router task id. */
function mergeRecorded(target: RunRecord, recorder: LlmRunRecorder | undefined): void {
  if (!recorder) return;
  const snapshot = recorder.snapshot();
  const seen = new Set(target.recorded.operations.map((entry) => entry.task_id));
  for (const operation of snapshot.operations) {
    if (seen.has(operation.task_id)) continue;
    seen.add(operation.task_id);
    target.recorded.operations.push(operation);
  }
  target.recorded.capability_rejections.push(...snapshot.capability_rejections);
  target.recorded.attribution_failures.push(...snapshot.attribution_failures);
  target.recorded.direct_provider_bypasses.push(
    ...dedupeBypasses(target.recorded.direct_provider_bypasses, snapshot.direct_provider_bypasses),
  );
}

/**
 * A bypass published while several recorders are open reaches all of them, so
 * merging two legs could double-count the same event. Only the events beyond
 * what the run already holds for a given site are added.
 */
function dedupeBypasses(
  existing: DirectProviderBypassEvidence[],
  incoming: DirectProviderBypassEvidence[],
): DirectProviderBypassEvidence[] {
  const heldBySite = new Map<string, number>();
  for (const entry of existing) {
    heldBySite.set(entry.site, (heldBySite.get(entry.site) ?? 0) + 1);
  }
  const added: DirectProviderBypassEvidence[] = [];
  const seenBySite = new Map<string, number>();
  for (const entry of incoming) {
    const index = (seenBySite.get(entry.site) ?? 0) + 1;
    seenBySite.set(entry.site, index);
    if (index > (heldBySite.get(entry.site) ?? 0)) added.push(entry);
  }
  return added;
}

/** Record the CompetitiveLandscape leg: the measured ranking LLM call count. */
export function recordCompetitiveLandscapeLeg(input: {
  client_id: string;
  build_id: string;
  ranking_llm_calls: number;
  recorder?: LlmRunRecorder;
  /** The consumer's own id for this run, echoed into the exported audit. */
  run_ref?: string;
  now?: string;
}): string {
  const target = record(
    input.client_id,
    input.build_id,
    input.now ?? new Date().toISOString(),
    input.run_ref,
  );
  target.legs.competitive_landscape = true;
  target.ranking_llm_calls = input.ranking_llm_calls;
  mergeRecorded(target, input.recorder);
  return target.run_id;
}

/** Record the SEOContentBlueprint leg: batch evidence + its governed calls. */
export function recordSeoContentBlueprintLeg(input: {
  client_id: string;
  build_id: string;
  evidence: SEOContentBlueprintEvidence;
  recorder?: LlmRunRecorder;
  /** The consumer's own id for this run, echoed into the exported audit. */
  run_ref?: string;
  now?: string;
}): string {
  const target = record(
    input.client_id,
    input.build_id,
    input.now ?? new Date().toISOString(),
    input.run_ref,
  );
  target.legs.seo_content_blueprint = true;
  target.blueprint = input.evidence;
  mergeRecorded(target, input.recorder);
  return target.run_id;
}

/** Record the StructuredContentPackage leg: per-route counters + its calls. */
export function recordStructuredContentLeg(input: {
  client_id: string;
  build_id: string;
  evidence: StructuredContentEvidence;
  recorder?: LlmRunRecorder;
  /** The consumer's own id for this run, echoed into the exported audit. */
  run_ref?: string;
  now?: string;
}): string {
  const target = record(
    input.client_id,
    input.build_id,
    input.now ?? new Date().toISOString(),
    input.run_ref,
  );
  target.legs.structured_content = true;
  target.content = input.evidence;
  mergeRecorded(target, input.recorder);
  return target.run_id;
}

/** The run's assembled audit, or `null` when the run is unknown or evicted. */
export function getRunLlmAudit(runId: string): RunLlmAuditV1 | null {
  const target = runs.get(runId);
  if (!target) return null;
  return assembleRunLlmAudit(target);
}

export function getRunLlmAuditFor(clientId: string, buildId: string): RunLlmAuditV1 | null {
  return getRunLlmAudit(runIdFor(clientId, buildId));
}

/**
 * Assemble the canonical document and validate it fail-closed before it can be
 * returned. A run whose evidence contradicts itself surfaces as a validation
 * failure — never as a plausible-looking audit.
 */
function assembleRunLlmAudit(target: RunRecord): RunLlmAuditV1 {
  const blueprint = target.blueprint;
  const content = target.content;
  const operationsFor = (operation: string) =>
    target.recorded.operations.filter((entry) => entry.operation === operation);

  return assertRunLlmAudit({
    schema: RUN_LLM_AUDIT_SCHEMA,
    run_id: target.run_ref ?? target.run_id,
    seo_run_id: target.run_id,
    run_id_source: target.run_ref === null ? "derived" : "consumer_supplied",
    client_id: target.client_id,
    build_id: target.build_id,
    produced_at: target.updated_at,
    producer: { repo: PRODUCER.repo, version: PRODUCER.version },
    legs: { ...target.legs },
    competitive_landscape: {
      executed: target.legs.competitive_landscape,
      ranking_llm_calls: target.ranking_llm_calls,
    },
    seo_content_blueprint: {
      executed: target.legs.seo_content_blueprint,
      route_count: blueprint?.route_count ?? 0,
      batch_size: blueprint?.batch_size ?? 1,
      batch_count: blueprint?.batch_count ?? 0,
      completed_batches: blueprint?.completed_batches ?? 0,
    },
    structured_content: {
      executed: target.legs.structured_content,
      route_results: (content?.route_results ?? []).map(
        ({ schema_failure_count: _schemaFailures, ...route }) => route,
      ),
    },
    operations: {
      SEO_CONTENT_BLUEPRINT: operationsFor("SEO_CONTENT_BLUEPRINT"),
      STRUCTURED_CONTENT_GENERATION: operationsFor("STRUCTURED_CONTENT_GENERATION"),
      CONTENT_VALIDATION: operationsFor("CONTENT_VALIDATION"),
    },
    direct_provider_bypass_count: target.recorded.direct_provider_bypasses.length,
    direct_provider_bypasses: target.recorded.direct_provider_bypasses.map((entry) => ({
      ...entry,
    })),
    unsupported_capability_combination_count: target.recorded.capability_rejections.length,
    unsupported_capability_combinations: target.recorded.capability_rejections.map((entry) => ({
      ...entry,
    })),
    attribution_failures: [
      ...target.recorded.attribution_failures.map((entry) => ({ ...entry })),
      // A run whose legs disagree about which run they belong to cannot be
      // correlated by anyone; it fails validation rather than picking a side.
      ...target.run_ref_conflicts.map((reason) => ({
        operation: "RUN_IDENTITY",
        purpose: "run-evidence-store",
        attempt: "initial" as const,
        reason,
      })),
    ],
  });
}

/** Test-only: drop every retained run. */
export function _resetRunEvidenceStore(): void {
  runs.clear();
}
