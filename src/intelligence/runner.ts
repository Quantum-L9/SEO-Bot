/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Run Orchestrator (ADR-0016)
 *
 * One reasoning cycle for one client:
 *
 *   Observe    → extractors read the operational tables and reporting views
 *   Diagnose   → signals, fingerprinted and suppression-filtered
 *   Prioritize → grouped into opportunities and scored
 *   Plan       → policy gate, then the existing execution policy
 *   Act        → a proposal on the existing action log, a job on the existing
 *                allow-list. Never a site write from here.
 *   Measure    → an attribution window opened for what actually executed
 *
 * Every step is durable: the run, its signals, its opportunities, and its
 * decisions are rows. An operator can reconstruct why the bot did something
 * months later from the database alone, without re-running anything.
 *
 * Idempotent by construction (AGENTS §7 — BullMQ is at-least-once): signals and
 * opportunities are keyed UNIQUE on (run_id, fingerprint) and inserted with
 * ON CONFLICT DO NOTHING, so a retried run converges instead of duplicating.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";
import { logAction } from "../core/execution-policy.js";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { type PlannedDecision, planOpportunity } from "./action-planner.js";
import { buildEvidencePack } from "./evidence-pack.js";
import { buildOpportunities } from "./opportunity-scorer.js";
import { openExperiment } from "./outcome-attributor.js";
import { loadPolicyState, refreshPolicyState } from "./policy-state.js";
import { allExtractors, applySuppression, extractSignals } from "./signal-extractor.js";
import type { ScoredOpportunity, SignalCandidate } from "./types.js";

const logger = createModuleLogger("intelligence:runner");

export type TriggerSource = "cron" | "manual" | "api";

export interface RunSummary {
  readonly runId: string;
  readonly clientId: string;
  readonly signalsExtracted: number;
  readonly signalsSuppressed: number;
  readonly opportunities: number;
  readonly ungroupedSignals: number;
  readonly proposals: number;
  readonly autoExecuted: number;
  readonly queuedForApproval: number;
  readonly jobsQueued: number;
  readonly extractorFailures: number;
}

interface ClientRow {
  readonly id: string;
  readonly industry: string;
  readonly state: string | null;
  readonly active: boolean;
}

/**
 * Run one client's cycle.
 *
 * `scheduler` is optional so the reasoning half can be exercised — and a run
 * recorded — without a live Redis connection. A run with no scheduler still
 * observes, diagnoses, prioritizes and decides; it simply queues no follow-up
 * jobs, and says so in the summary.
 */
export async function runClientTriage(
  clientId: string,
  triggerSource: TriggerSource,
  scheduler?: Scheduler,
): Promise<RunSummary> {
  const db = getDb();
  const config = getConfig();
  const startedAt = Date.now();

  const [runRow] = await db
    .insert(schema.intelligenceRuns)
    .values({
      clientId,
      runType: "daily_client_triage",
      triggerSource,
      status: "running",
      // Zero tokens: extraction, grouping, scoring and policy are all
      // deterministic. An LLM is only reached later, by the jobs this run queues.
      llmUsed: false,
    })
    .returning({ id: schema.intelligenceRuns.id });
  const runId = runRow.id;

  try {
    const [client] = await db
      .select({
        id: schema.clients.id,
        industry: schema.clients.industry,
        state: schema.clients.state,
        active: schema.clients.active,
      })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) throw new Error(`Client ${clientId} not found`);

    const summary = await executeCycle(runId, client, config, scheduler);

    await db
      .update(schema.intelligenceRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        metadata: runMetadata(summary),
      })
      .where(eq(schema.intelligenceRuns.id, runId));

    logger.info(summary, "Intelligence run completed");
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.intelligenceRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        error: message,
      })
      .where(eq(schema.intelligenceRuns.id, runId))
      .catch(() => undefined);
    logger.error({ runId, clientId, err: message }, "Intelligence run failed");
    throw error;
  }
}

async function executeCycle(
  runId: string,
  client: ClientRow,
  config: ReturnType<typeof getConfig>,
  scheduler: Scheduler | undefined,
): Promise<RunSummary> {
  const db = getDb();
  const clientId = client.id;

  // ── Observe / Diagnose ────────────────────────────────────────────────────
  const { signals: rawSignals, failures } = await extractSignals(
    clientId,
    allExtractors(config.DEFAULT_CLIENT_MONTHLY_BUDGET),
  );

  const cooldownStart = new Date(
    Date.now() - config.INTELLIGENCE_SIGNAL_COOLDOWN_DAYS * 86_400_000,
  );
  const recentFingerprints = await loadRecentFingerprints(clientId, cooldownStart, rawSignals);
  const { kept, suppressed } = applySuppression(rawSignals, recentFingerprints);

  if (kept.length > 0) {
    await db
      .insert(schema.intelligenceSignals)
      .values(
        kept.map((signal) => ({
          runId,
          clientId: signal.clientId,
          entityType: signal.entityType,
          entityId: signal.entityId,
          signalType: signal.signalType,
          severity: signal.severity,
          confidence: signal.confidence.toFixed(4),
          evidence: signal.evidence as Record<string, unknown>,
          fingerprint: signal.fingerprint,
          suppressedUntil: new Date(
            Date.now() + config.INTELLIGENCE_SIGNAL_COOLDOWN_DAYS * 86_400_000,
          ),
        })),
      )
      .onConflictDoNothing();
  }

  // ── Prioritize ────────────────────────────────────────────────────────────
  const { opportunities, ungrouped } = buildOpportunities(kept);

  if (opportunities.length > 0) {
    await db
      .insert(schema.intelligenceOpportunities)
      .values(
        opportunities.map((opportunity) => ({
          runId,
          clientId: opportunity.clientId,
          opportunityType: opportunity.opportunityType,
          title: opportunity.title,
          description: opportunity.description,
          targetUrl: opportunity.targetUrl,
          targetKeyword: opportunity.targetKeyword,
          expectedImpact: opportunity.expectedImpact.toFixed(4),
          effort: opportunity.effort.toFixed(4),
          risk: opportunity.risk.toFixed(4),
          urgency: opportunity.urgency.toFixed(4),
          confidence: opportunity.confidence.toFixed(4),
          score: opportunity.score.toFixed(4),
          fingerprint: opportunity.fingerprint,
          evidence: opportunity.evidence as Record<string, unknown>,
        })),
      )
      .onConflictDoNothing();
  }

  // Resolve each opportunity's row id AFTER the insert rather than from
  // `.returning()`: ON CONFLICT DO NOTHING omits skipped rows from RETURNING, so
  // on a retried run the returned set would be empty and every decision would
  // record a null opportunity_id — exactly the orphaned link this lookup avoids.
  const opportunityIds = await loadOpportunityIds(runId);

  // ── Plan / Act ────────────────────────────────────────────────────────────
  const policyState = await refreshPolicyState(clientId);
  const openFingerprints = await loadOpenOpportunityFingerprints(clientId, runId, cooldownStart);

  let actionsTaken = 0;
  let proposals = 0;
  let autoExecuted = 0;
  let queuedForApproval = 0;
  let jobsQueued = 0;

  for (const opportunity of opportunities) {
    const planned = planOpportunity(opportunity, {
      policyState,
      clientActive: client.active,
      minScore: config.INTELLIGENCE_MIN_OPPORTUNITY_SCORE,
      maxActionsPerRun: config.INTELLIGENCE_MAX_ACTIONS_PER_RUN,
      actionsTakenThisRun: actionsTaken,
      openFingerprints,
    });

    const actionLogId = planned.proposal
      ? await logAction(
          planned.proposal,
          planned.execution ?? { execute: false, reason: "", requiresApproval: true },
        )
      : null;

    // The pack is stored, not just built: it is the redacted artifact any later
    // LLM step is allowed to see, so persisting it means the model never needs
    // to reach back into the database to reconstruct context.
    const evidencePack = buildEvidencePack(opportunity, {
      industry: client.industry,
      market: client.state,
    });

    const [decisionRow] = await db
      .insert(schema.intelligenceDecisions)
      .values({
        runId,
        clientId,
        opportunityId: opportunityIds.get(opportunity.fingerprint) ?? null,
        decisionType: opportunity.opportunityType,
        decision: planned.verdict.decision,
        rationale: planned.verdict.rationale,
        policyBasis: {
          blockers: planned.verdict.blockers,
          score: opportunity.score,
          min_score: config.INTELLIGENCE_MIN_OPPORTUNITY_SCORE,
          opportunity_fingerprint: opportunity.fingerprint,
          execution_policy: planned.execution
            ? { execute: planned.execution.execute, reason: planned.execution.reason }
            : null,
        },
        evidenceSummary: evidencePack as unknown as Record<string, unknown>,
        requiresApproval: planned.execution?.requiresApproval ?? false,
        actionLogId,
      })
      .returning({ id: schema.intelligenceDecisions.id });

    if (!planned.proposal || !planned.template) continue;

    proposals += 1;
    actionsTaken += 1;

    if (planned.execution?.execute) {
      autoExecuted += 1;
      jobsQueued += await onExecutedProposal(
        planned,
        opportunity,
        config,
        scheduler,
        decisionRow?.id ?? null,
      );
    } else {
      // Held for approval. No experiment window opens yet: measuring from a
      // moment nothing happened would attribute the world's noise to the bot.
      queuedForApproval += 1;
    }
  }

  return {
    runId,
    clientId,
    signalsExtracted: kept.length,
    signalsSuppressed: suppressed.length,
    opportunities: opportunities.length,
    ungroupedSignals: ungrouped.length,
    proposals,
    autoExecuted,
    queuedForApproval,
    jobsQueued,
    extractorFailures: failures.length,
  };
}

/**
 * Record the outcome row, open the attribution window, and queue the follow-up
 * job — in that order, so the experiment always references a real outcome row.
 */
async function onExecutedProposal(
  planned: PlannedDecision,
  opportunity: ScoredOpportunity,
  config: ReturnType<typeof getConfig>,
  scheduler: Scheduler | undefined,
  decisionId: string | null,
): Promise<number> {
  const db = getDb();
  const template = planned.template;
  const proposal = planned.proposal;
  if (!template || !proposal) return 0;

  const executedAt = new Date();

  const [outcome] = await db
    .insert(schema.actionOutcomes)
    .values({
      clientId: opportunity.clientId,
      module: template.module,
      action: template.action,
      executedAt,
    })
    .returning({ id: schema.actionOutcomes.id });

  const entityId = attributionEntity(template.targetMetric, opportunity);
  if (entityId) {
    await openExperiment({
      clientId: opportunity.clientId,
      decisionId,
      actionOutcomeId: outcome.id,
      hypothesis: template.hypothesis,
      targetMetric: template.targetMetric,
      entityType: template.targetMetric === "serp_position" ? "keyword" : "page",
      entityId,
      executedAt,
      baselineDays: config.INTELLIGENCE_BASELINE_DAYS,
      measurementDays: config.INTELLIGENCE_MEASUREMENT_DAYS,
    });
  } else {
    logger.warn(
      { opportunityType: opportunity.opportunityType, metric: template.targetMetric },
      "No attribution entity for this opportunity — action recorded without a measurement window",
    );
  }

  if (!template.followUpJob) return 0;
  if (!scheduler) {
    logger.warn({ job: template.followUpJob }, "No scheduler available — follow-up job not queued");
    return 0;
  }

  await scheduler.addJob(template.followUpJob, { clientId: opportunity.clientId });
  return 1;
}

/** Which entity a metric is measured against. Null when the opportunity has none. */
export function attributionEntity(
  metric: "serp_position" | "page_exit_rate" | "aeo_citation_rate",
  opportunity: ScoredOpportunity,
): string | null {
  if (metric === "serp_position") return opportunity.targetKeyword;
  if (metric === "page_exit_rate") return opportunity.targetUrl;
  // Citation rate is measured per platform; the platform lives on the signal.
  const platformSignal = opportunity.signals.find(
    (signal) => signal.entityType === "platform" && typeof signal.evidence.platform === "string",
  );
  return platformSignal ? String(platformSignal.evidence.platform) : null;
}

/**
 * Counters only — `runId` and `clientId` are already columns on the run row, and
 * duplicating them inside its own metadata invites the two to disagree.
 */
function runMetadata(summary: RunSummary): Record<string, unknown> {
  const { runId: _runId, clientId: _clientId, ...counters } = summary;
  return counters;
}

/** This run's opportunity row ids, keyed by fingerprint. */
async function loadOpportunityIds(runId: string): Promise<Map<string, string>> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.intelligenceOpportunities.id,
      fingerprint: schema.intelligenceOpportunities.fingerprint,
    })
    .from(schema.intelligenceOpportunities)
    .where(eq(schema.intelligenceOpportunities.runId, runId));
  return new Map(rows.map((row) => [row.fingerprint, row.id]));
}

/** Fingerprints seen inside the cooldown window, for suppression. */
async function loadRecentFingerprints(
  clientId: string,
  since: Date,
  candidates: readonly SignalCandidate[],
): Promise<Set<string>> {
  const fingerprints = [...new Set(candidates.map((signal) => signal.fingerprint))];
  if (fingerprints.length === 0) return new Set();

  const db = getDb();
  const rows = await db
    .select({ fingerprint: schema.intelligenceSignals.fingerprint })
    .from(schema.intelligenceSignals)
    .where(
      and(
        eq(schema.intelligenceSignals.clientId, clientId),
        gte(schema.intelligenceSignals.observedAt, since),
        inArray(schema.intelligenceSignals.fingerprint, fingerprints),
      ),
    );
  return new Set(rows.map((row) => row.fingerprint));
}

/**
 * Opportunity fingerprints recently raised for this client, excluding the ones
 * this run just wrote — otherwise every opportunity would suppress itself.
 *
 * The `since` bound is load-bearing, not a performance tweak. `status` has no
 * transition yet (nothing closes an opportunity — see ADR-0016, and the
 * lifecycle contract in docs/seo-sql/CONTRACTS.md), so an unbounded
 * `status = 'open'` filter matches every opportunity ever recorded. That would
 * make suppression PERMANENT: a problem acted on once and not actually fixed
 * would be re-detected by the extractors, re-grouped into the same fingerprint,
 * and then silently discarded on every subsequent run, forever. Bounding the
 * window to the same cooldown that governs signals means a recurring problem
 * comes back after the cooldown instead of disappearing.
 */
async function loadOpenOpportunityFingerprints(
  clientId: string,
  runId: string,
  since: Date,
): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ fingerprint: schema.intelligenceOpportunities.fingerprint })
    .from(schema.intelligenceOpportunities)
    .where(
      and(
        eq(schema.intelligenceOpportunities.clientId, clientId),
        eq(schema.intelligenceOpportunities.status, "open"),
        gte(schema.intelligenceOpportunities.createdAt, since),
        sql`${schema.intelligenceOpportunities.runId} IS DISTINCT FROM ${runId}::uuid`,
      ),
    );
  return new Set(rows.map((row) => row.fingerprint));
}

/** Recompute governor state for every active client. */
export async function refreshAllPolicyState(): Promise<number> {
  const db = getDb();
  const clients = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.active, true));

  let refreshed = 0;
  for (const client of clients) {
    try {
      await refreshPolicyState(client.id);
      refreshed += 1;
    } catch (error) {
      logger.error(
        { clientId: client.id, err: error instanceof Error ? error.message : String(error) },
        "Policy state refresh failed",
      );
    }
  }
  return refreshed;
}

export { loadPolicyState };
