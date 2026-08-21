/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * l9.seo-bot-run-llm-audit/v1 — the canonical per-run LLM evidence surface.
 *
 * ONE document per build-intelligence run (client_id + build_id), assembled from
 * measurements taken at the layers that actually know:
 *
 *   ranking_llm_calls              CompetitiveLandscape's own evidence summary.
 *   seo_content_blueprint.*        The producer's deterministic batch split and
 *                                  its COUNTED completed-batch tally.
 *   structured_content.route_results[]
 *                                  Per-route, per-call counters incremented by
 *                                  `LlmService.executePolicyJson` after each
 *                                  ACTUAL router call — never a package total
 *                                  divided by a route count, never a constant.
 *   operations.*                   One entry per ACTUAL router call, carrying
 *                                  the search policy the ROUTER applied.
 *   direct_provider_bypass_count   Length of the observed bypass-event list.
 *   unsupported_capability_combination_count
 *                                  Length of the observed capability-rejection
 *                                  list.
 *
 * `assertRunLlmAudit` is fail-closed: it re-derives every counter from its
 * evidence list, re-checks every invariant the run is supposed to have held,
 * and throws `RunLlmAuditInvalidError` on anything malformed, missing, or
 * internally inconsistent. A producer cannot make this document say PASS by
 * asserting numbers into it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { AUDITED_OPERATIONS, type AuditedOperation } from "../services/llm-run-recorder.js";

export const RUN_LLM_AUDIT_SCHEMA = "l9.seo-bot-run-llm-audit/v1" as const;

/** Bound proven by `structured-content.ts`: a route repairs at most once. */
export const MAX_REPAIR_ATTEMPTS_PER_ROUTE = 1;

/** Malformed, missing, or self-inconsistent run evidence. Never downgraded. */
export class RunLlmAuditInvalidError extends Error {
  readonly code = "RUN_LLM_AUDIT_INVALID";
  constructor(
    message: string,
    readonly violations: string[] = [],
  ) {
    super(message);
    this.name = "RunLlmAuditInvalidError";
  }
}

/**
 * Deterministic run identity. The three build-intelligence endpoints are three
 * HTTP calls in ONE run, so the run id must be derivable by both producer and
 * consumer from the run's own identity rather than minted per request.
 */
export function runIdFor(clientId: string, buildId: string): string {
  if (!clientId.trim() || !buildId.trim()) {
    throw new RunLlmAuditInvalidError("run identity requires a non-empty client_id and build_id");
  }
  const digest = createHash("sha256").update(`${clientId}\n${buildId}`, "utf8").digest("hex");
  return `seo-run:${digest}`;
}

/* ── Schema ──────────────────────────────────────────────────────────────────── */

const operationExecutionSchema = z
  .object({
    operation: z.enum(AUDITED_OPERATIONS),
    purpose: z.string().min(1),
    attempt: z.enum(["initial", "repair"]),
    task_id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    // Verbatim router evidence keeps the router's camelCase spelling; the enum
    // NAME is recorded, so an unrecognised source value fails here rather than
    // being silently normalized into a canonical-looking one.
    searchRequired: z.boolean(),
    searchPolicySource: z.enum(["EXPLICIT", "TASK_DEFAULT"]),
    descriptor_requires_search: z.boolean().nullable(),
    outcome: z.enum(["SUCCESS", "FAILED"]),
  })
  .strict();

const routeResultSchema = z
  .object({
    route_id: z.string().min(1),
    path: z.string().min(1),
    generation_calls: z.number().int().min(1),
    repair_attempts: z.number().int().min(0).max(MAX_REPAIR_ATTEMPTS_PER_ROUTE),
    semantic_validation_calls: z.number().int().min(0),
  })
  .strict();

const capabilityRejectionSchema = z
  .object({
    code: z.string().min(1),
    task_type: z.string().min(1),
    operation: z.string().min(1).nullable(),
    message: z.string(),
  })
  .strict();

const directProviderBypassSchema = z
  .object({
    site: z.string().min(1),
    engine: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

const attributionFailureSchema = z
  .object({
    operation: z.string().min(1),
    purpose: z.string().min(1),
    attempt: z.enum(["initial", "repair"]),
    reason: z.string().min(1),
  })
  .strict();

const runLlmAuditSchema = z
  .object({
    schema: z.literal(RUN_LLM_AUDIT_SCHEMA),
    /**
     * The run's identity for a consumer correlating this audit against its own
     * record of the same run: the consumer-supplied `run_ref` when one was
     * given, otherwise SEO-Bot's derived id.
     */
    run_id: z.string().min(1),
    /** SEO-Bot's own derived id — always the store key, whatever `run_id` is. */
    seo_run_id: z.string().min(1),
    /** Which of the two `run_id` is. */
    run_id_source: z.enum(["consumer_supplied", "derived"]),
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    produced_at: z.string().min(1),
    producer: z.object({ repo: z.string().min(1), version: z.string().min(1) }).strict(),
    legs: z
      .object({
        competitive_landscape: z.boolean(),
        seo_content_blueprint: z.boolean(),
        structured_content: z.boolean(),
      })
      .strict(),
    /** One block per producer leg, so every leg reads the same way. */
    competitive_landscape: z
      .object({
        executed: z.boolean(),
        ranking_llm_calls: z.number().int().min(0),
      })
      .strict(),
    seo_content_blueprint: z
      .object({
        executed: z.boolean(),
        route_count: z.number().int().min(0),
        batch_size: z.number().int().min(1),
        batch_count: z.number().int().min(0),
        completed_batches: z.number().int().min(0),
      })
      .strict(),
    structured_content: z
      .object({
        executed: z.boolean(),
        route_results: z.array(routeResultSchema),
      })
      .strict(),
    operations: z
      .object({
        SEO_CONTENT_BLUEPRINT: z.array(operationExecutionSchema),
        STRUCTURED_CONTENT_GENERATION: z.array(operationExecutionSchema),
        CONTENT_VALIDATION: z.array(operationExecutionSchema),
      })
      .strict(),
    direct_provider_bypass_count: z.number().int().min(0),
    direct_provider_bypasses: z.array(directProviderBypassSchema),
    unsupported_capability_combination_count: z.number().int().min(0),
    unsupported_capability_combinations: z.array(capabilityRejectionSchema),
    attribution_failures: z.array(attributionFailureSchema),
  })
  .strict();

export type RunLlmAuditV1 = z.infer<typeof runLlmAuditSchema>;
export type RunLlmAuditOperationExecution = z.infer<typeof operationExecutionSchema>;
export type RunLlmAuditRouteResult = z.infer<typeof routeResultSchema>;

/* ── Fail-closed validation ──────────────────────────────────────────────────── */

/**
 * Validate a run audit. Shape first (strict — an unknown field is a rejection,
 * not an extension), then every invariant the recorded evidence must satisfy.
 * Throws `RunLlmAuditInvalidError` listing EVERY violation found.
 */
export function assertRunLlmAudit(value: unknown): RunLlmAuditV1 {
  const parsed = runLlmAuditSchema.safeParse(value);
  if (!parsed.success) {
    throw new RunLlmAuditInvalidError(
      "run LLM audit does not satisfy l9.seo-bot-run-llm-audit/v1",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  const audit = parsed.data;
  const violations = runLlmAuditViolations(audit);
  if (violations.length > 0) {
    throw new RunLlmAuditInvalidError(
      "run LLM audit contradicts the evidence it carries",
      violations,
    );
  }
  return audit;
}

/** Every semantic invariant, as a violation list (empty === valid). */
export function runLlmAuditViolations(audit: RunLlmAuditV1): string[] {
  const violations: string[] = [];

  // ── Identity is derived, not asserted ──────────────────────────────────────
  // `seo_run_id` is ALWAYS the deterministic id, so SEO-Bot's own addressing
  // stays checkable even when the exported `run_id` is the consumer's.
  if (audit.seo_run_id !== runIdFor(audit.client_id, audit.build_id)) {
    violations.push("seo_run_id is not the deterministic id of (client_id, build_id)");
  }
  if (audit.run_id_source === "derived" && audit.run_id !== audit.seo_run_id) {
    violations.push("run_id_source is derived but run_id is not the derived id");
  }
  if (audit.run_id_source === "consumer_supplied" && audit.run_id === audit.seo_run_id) {
    violations.push(
      "run_id_source is consumer_supplied but run_id is the derived id; no consumer ref was recorded",
    );
  }
  if (Number.isNaN(Date.parse(audit.produced_at))) {
    violations.push("produced_at is not an ISO timestamp");
  }

  // ── Counters are LENGTHS of their evidence lists, never constants ──────────
  if (audit.direct_provider_bypass_count !== audit.direct_provider_bypasses.length) {
    violations.push(
      `direct_provider_bypass_count is ${audit.direct_provider_bypass_count} but ` +
        `${audit.direct_provider_bypasses.length} bypass event(s) were recorded`,
    );
  }
  if (
    audit.unsupported_capability_combination_count !==
    audit.unsupported_capability_combinations.length
  ) {
    violations.push(
      `unsupported_capability_combination_count is ` +
        `${audit.unsupported_capability_combination_count} but ` +
        `${audit.unsupported_capability_combinations.length} rejection(s) were recorded`,
    );
  }

  // ── Unattributable evidence fails the audit; it is never under-reported ────
  for (const failure of audit.attribution_failures) {
    violations.push(
      `unattributed ${failure.operation} ${failure.attempt} call (${failure.purpose}): ${failure.reason}`,
    );
  }

  // ── Ranking authority is deterministic: zero LLM calls, measured ───────────
  const ranking = audit.competitive_landscape;
  if (ranking.executed !== audit.legs.competitive_landscape) {
    violations.push("competitive_landscape.executed disagrees with legs.competitive_landscape");
  }
  if (ranking.ranking_llm_calls !== 0) {
    violations.push(
      `competitive_landscape.ranking_llm_calls is ${ranking.ranking_llm_calls}, ` +
        `must be 0 (deterministic rank authority)`,
    );
  }

  violations.push(...blueprintViolations(audit));
  violations.push(...routeResultViolations(audit));
  violations.push(...operationViolations(audit));
  return violations;
}

/** Batch evidence must describe the split the producer deterministically made. */
function blueprintViolations(audit: RunLlmAuditV1): string[] {
  const violations: string[] = [];
  const blueprint = audit.seo_content_blueprint;
  if (blueprint.executed !== audit.legs.seo_content_blueprint) {
    violations.push("seo_content_blueprint.executed disagrees with legs.seo_content_blueprint");
  }
  if (!blueprint.executed) {
    if (blueprint.route_count !== 0 || blueprint.batch_count !== 0) {
      violations.push("seo_content_blueprint carries batch evidence for a leg that never ran");
    }
    if (audit.operations.SEO_CONTENT_BLUEPRINT.length > 0) {
      violations.push("operations.SEO_CONTENT_BLUEPRINT records calls for a leg that never ran");
    }
    return violations;
  }
  if (blueprint.route_count <= 0) {
    violations.push("seo_content_blueprint.route_count is 0 on an executed leg");
  }
  const expectedBatches = Math.ceil(blueprint.route_count / blueprint.batch_size);
  if (blueprint.batch_count !== expectedBatches) {
    violations.push(
      `seo_content_blueprint.batch_count is ${blueprint.batch_count}; a deterministic split of ` +
        `${blueprint.route_count} route(s) at batch_size ${blueprint.batch_size} is ${expectedBatches}`,
    );
  }
  if (blueprint.completed_batches !== blueprint.batch_count) {
    violations.push(
      `seo_content_blueprint.completed_batches is ${blueprint.completed_batches} of ` +
        `${blueprint.batch_count}; a partial route set never seals`,
    );
  }
  // Phase A is one global-intent call, then one call per batch — each may spend
  // its one bounded repair, so the floor is 1 + batch_count.
  const minimumCalls = blueprint.batch_count + 1;
  const observed = audit.operations.SEO_CONTENT_BLUEPRINT.length;
  if (observed < minimumCalls) {
    violations.push(
      `operations.SEO_CONTENT_BLUEPRINT records ${observed} call(s); the deterministic split ` +
        `requires at least ${minimumCalls} (global intent + ${blueprint.batch_count} batch(es))`,
    );
  }
  if (observed > minimumCalls * 2) {
    violations.push(
      `operations.SEO_CONTENT_BLUEPRINT records ${observed} call(s); at most one bounded repair ` +
        `per call permits ${minimumCalls * 2}`,
    );
  }
  return violations;
}

/**
 * Per-route generation/repair accounting. `generation_calls` is a measured
 * count, and the maximum-one-repair invariant makes it exactly
 * `1 + repair_attempts` — so a route whose counters disagree is rejected rather
 * than reconciled.
 */
function routeResultViolations(audit: RunLlmAuditV1): string[] {
  const violations: string[] = [];
  const content = audit.structured_content;
  if (content.executed !== audit.legs.structured_content) {
    violations.push("structured_content.executed disagrees with legs.structured_content");
  }
  if (!content.executed) {
    if (content.route_results.length > 0) {
      violations.push("structured_content.route_results is populated for a leg that never ran");
    }
    if (audit.operations.STRUCTURED_CONTENT_GENERATION.length > 0) {
      violations.push(
        "operations.STRUCTURED_CONTENT_GENERATION records calls for a leg that never ran",
      );
    }
    if (audit.operations.CONTENT_VALIDATION.length > 0) {
      violations.push("operations.CONTENT_VALIDATION records calls for a leg that never ran");
    }
    return violations;
  }
  if (content.route_results.length === 0) {
    violations.push("structured_content.route_results is empty on an executed leg");
  }

  const seenRouteIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const route of content.route_results) {
    if (seenRouteIds.has(route.route_id)) {
      violations.push(`duplicate route_id in route_results: ${route.route_id}`);
    }
    seenRouteIds.add(route.route_id);
    if (seenPaths.has(route.path)) {
      violations.push(`duplicate path in route_results: ${route.path}`);
    }
    seenPaths.add(route.path);
    if (route.generation_calls !== route.repair_attempts + 1) {
      violations.push(
        `route "${route.route_id}" reports ${route.generation_calls} generation call(s) with ` +
          `${route.repair_attempts} repair attempt(s); one initial call plus at most one repair ` +
          `means generation_calls must equal repair_attempts + 1`,
      );
    }
    if (route.semantic_validation_calls > route.generation_calls) {
      violations.push(
        `route "${route.route_id}" reports ${route.semantic_validation_calls} semantic validation ` +
          `call(s) for ${route.generation_calls} generation call(s)`,
      );
    }
  }

  // Two independent measurements of the same thing must agree: the per-route
  // counters incremented at the LLM boundary, and the router decisions
  // attributed to STRUCTURED_CONTENT_GENERATION.
  const routeTotal = content.route_results.reduce((sum, route) => sum + route.generation_calls, 0);
  const attributed = audit.operations.STRUCTURED_CONTENT_GENERATION.length;
  if (routeTotal !== attributed) {
    violations.push(
      `route_results account for ${routeTotal} generation call(s) but ${attributed} router ` +
        `decision(s) were attributed to STRUCTURED_CONTENT_GENERATION`,
    );
  }
  return violations;
}

/**
 * Governed LLM policy evidence. The router reports which search policy it
 * APPLIED and where it came from; `EXPLICIT` is only truthful when the governed
 * operation actually supplied a `requiresSearch` boolean, and the applied value
 * must be the value supplied.
 */
function operationViolations(audit: RunLlmAuditV1): string[] {
  const violations: string[] = [];
  for (const operation of AUDITED_OPERATIONS) {
    for (const execution of audit.operations[operation]) {
      const label = `${operation} ${execution.attempt} call ${execution.task_id}`;
      if (execution.operation !== operation) {
        violations.push(`${label} is filed under the wrong operation`);
      }
      if (execution.outcome !== "SUCCESS") {
        violations.push(`${label} did not complete (outcome ${execution.outcome})`);
      }
      if (execution.searchPolicySource === "EXPLICIT") {
        if (typeof execution.descriptor_requires_search !== "boolean") {
          violations.push(
            `${label} records searchPolicySource EXPLICIT but the governed operation supplied ` +
              `no requiresSearch policy`,
          );
        } else if (execution.descriptor_requires_search !== execution.searchRequired) {
          violations.push(
            `${label} applied searchRequired=${execution.searchRequired} while the governed ` +
              `operation supplied requiresSearch=${execution.descriptor_requires_search}`,
          );
        }
      } else if (execution.descriptor_requires_search !== null) {
        violations.push(
          `${label} records searchPolicySource TASK_DEFAULT although the governed operation ` +
            `supplied requiresSearch=${execution.descriptor_requires_search}`,
        );
      }
      // All three audited operations consume normalized evidence; a search
      // provider on any of them is a policy violation, recorded as such.
      if (execution.searchRequired) {
        violations.push(`${label} resolved to a search-backed route`);
      }
    }
  }
  return violations;
}

/** Convenience view for a consumer that only needs the operation inventory. */
export function operationCallCount(audit: RunLlmAuditV1, operation: AuditedOperation): number {
  return audit.operations[operation].length;
}
