/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: job handlers and registration
 *
 * The loop's four stages, each as a BullMQ job. This module owns no scheduling
 * of its own and no async execution path of its own: it registers definitions
 * with the shared Scheduler and lets that Scheduler's worker run them, so
 * intelligence work is logged, retried, fanned out per client, and budgeted
 * exactly like every other job in the system.
 *
 * Registration is conditional on INTELLIGENCE_MODE. At `off` no definition is
 * added, so an unconfigured deployment schedules nothing and writes nothing —
 * the mode is not merely checked inside the handlers, it decides whether the
 * jobs exist.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { getConfig } from "../../core/config.js";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import type { Scheduler } from "../../core/scheduler.js";
import type { JobDefinition } from "../../types/index.js";
import { deterministicActionFor, routePlannedAction } from "./action-router.js";
import { planActionsWithLlm } from "./llm-planner.js";
import { scoreOpportunities } from "./opportunity-scorer.js";
import { attributeOutcomes } from "./outcome-attributor.js";
import { assertClientId, checkCapability, currentMode } from "./policy-gate.js";
import { extractSignals } from "./signal-extractor.js";
import type { OpportunityType, PlannedAction } from "./types.js";

const logger = createModuleLogger("intelligence");

/**
 * Job definitions for the loop.
 *
 * All four are client-scoped so the Scheduler's fan-out gives each client its
 * own child job with its own deterministic id — the same mechanism that keeps
 * the producer modules from double-processing a tenant on a parent retry.
 *
 * Only `intelligence:plan-actions` carries a strategic token budget. Extraction
 * and scoring are pure SQL and arithmetic; giving them a nonzero budget would
 * misstate where this module can spend money.
 */
export const INTELLIGENCE_JOB_DEFINITIONS: readonly JobDefinition[] = Object.freeze([
  {
    name: "intelligence:extract-signals",
    module: "intelligence",
    cron: "30 6 * * *",
    handler: "extractSignals",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: "intelligence:score-opportunities",
    module: "intelligence",
    cron: "45 6 * * *",
    handler: "scoreOpportunities",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: "intelligence:plan-actions",
    module: "intelligence",
    cron: "0 7 * * *",
    handler: "planActions",
    clientScoped: true,
    tokenBudget: {
      maxFastTokensPerRun: 1000,
      maxStrategicTokensPerRun: 6000,
      cooldownMinutes: 120,
    },
    enabled: true,
  },
  {
    name: "intelligence:attribute-outcomes",
    module: "intelligence",
    cron: "0 13 * * 6",
    handler: "attributeOutcomes",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
]);

/** Open a run row, returning its id so every write can be traced to it. */
async function openRun(clientId: string, runType: string): Promise<string> {
  const db = getDb();
  const [run] = await db
    .insert(schema.intelligenceRuns)
    .values({ clientId, runType, mode: currentMode(), status: "running", startedAt: new Date() })
    .returning({ id: schema.intelligenceRuns.id });
  return run.id;
}

async function closeRun(
  runId: string,
  counts: Partial<{
    signalsWritten: number;
    opportunitiesWritten: number;
    decisionsWritten: number;
    jobsRouted: number;
  }>,
  error?: unknown,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.intelligenceRuns)
    .set({
      status: error ? "failed" : "completed",
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      completedAt: new Date(),
      ...counts,
    })
    .where(eq(schema.intelligenceRuns.id, runId));
}

/**
 * Stage 1 — observe.
 *
 * Available from `observe` upward. Blocked at `off`, where the job is not even
 * registered; the capability check is the second line of defence for a manual
 * trigger against a running process whose mode was lowered.
 */
export async function handleExtractSignals(job: Job): Promise<void> {
  const clientId = job.data.clientId as string;
  assertClientId(clientId);

  const capability = checkCapability("write_signals");
  if (!capability.allowed) {
    logger.info({ clientId, reason: capability.reason }, "signal extraction skipped");
    return;
  }

  const runId = await openRun(clientId, "extract_signals");
  try {
    const signals = await extractSignals(clientId, { runId });
    await closeRun(runId, { signalsWritten: signals.length });
  } catch (error: unknown) {
    await closeRun(runId, {}, error);
    throw error;
  }
}

/** Stage 2 — score. Deterministic; no LLM, no routing. */
export async function handleScoreOpportunities(job: Job): Promise<void> {
  const clientId = job.data.clientId as string;
  assertClientId(clientId);

  const capability = checkCapability("write_signals");
  if (!capability.allowed) {
    logger.info({ clientId, reason: capability.reason }, "opportunity scoring skipped");
    return;
  }

  const runId = await openRun(clientId, "score_opportunities");
  try {
    const opportunities = await scoreOpportunities(clientId);
    await closeRun(runId, { opportunitiesWritten: opportunities.length });
  } catch (error: unknown) {
    await closeRun(runId, {}, error);
    throw error;
  }
}

/**
 * Stage 3 — plan and route.
 *
 * Requires `recommend` at minimum: below it there is nothing to record, since
 * observe mode is defined as producing no decisions at all.
 *
 * The LLM planner is consulted only when the `llm_planning` capability is
 * granted. Otherwise the plan is derived deterministically from each
 * opportunity's type — which is why `route_safe` is a usable production mode
 * on its own and does not depend on a model being reachable.
 */
export async function handlePlanActions(job: Job): Promise<void> {
  const clientId = job.data.clientId as string;
  const clientConfig = job.data.clientConfig as Record<string, unknown> | undefined;
  assertClientId(clientId);

  const capability = checkCapability("write_decisions");
  if (!capability.allowed) {
    logger.info({ clientId, reason: capability.reason }, "action planning skipped");
    return;
  }

  const runId = await openRun(clientId, "plan_actions");
  try {
    const planned = await buildPlan({ clientId, clientConfig });

    // In `recommend` the loop stops here: proposals are recorded on action_log
    // by the router, but the safe-routing capability is not granted at that
    // mode, so nothing is enqueued.
    let jobsRouted = 0;
    let decisionsWritten = 0;
    const scheduler = await resolveScheduler();

    for (const action of planned) {
      const outcome = await routePlannedAction({
        planned: action,
        sink: scheduler,
        clientConfig,
        runId,
      });
      decisionsWritten += 1;
      jobsRouted += outcome.routedJobs.length;
    }

    await closeRun(runId, { decisionsWritten, jobsRouted });
    logger.info({ clientId, planned: planned.length, jobsRouted }, "action planning complete");
  } catch (error: unknown) {
    await closeRun(runId, {}, error);
    throw error;
  }
}

/** Stage 4 — attribute. Read-mostly; writes only to action_outcomes. */
export async function handleAttributeOutcomes(job: Job): Promise<void> {
  const clientId = job.data.clientId as string;
  assertClientId(clientId);

  const capability = checkCapability("write_signals");
  if (!capability.allowed) return;

  const runId = await openRun(clientId, "attribute_outcomes");
  try {
    await attributeOutcomes(clientId);
    await closeRun(runId, {});
  } catch (error: unknown) {
    await closeRun(runId, {}, error);
    throw error;
  }
}

/**
 * Produce the plan: the LLM's proposals when planning is enabled, otherwise the
 * deterministic mapping from open opportunities.
 *
 * A rejected or unavailable planner falls back to the deterministic plan rather
 * than to nothing — the loop's safe behaviour should not depend on a model
 * being up, and the deterministic path is the one that was true before the LLM
 * was ever consulted.
 */
async function buildPlan(params: {
  clientId: string;
  clientConfig?: Record<string, unknown>;
}): Promise<PlannedAction[]> {
  const { clientId, clientConfig } = params;

  if (checkCapability("llm_planning").allowed) {
    const { actions } = await planActionsWithLlm({ clientId, clientConfig });
    if (actions.length > 0) return actions;
  }

  const db = getDb();
  const opportunities = await db
    .select({
      fingerprint: schema.intelligenceOpportunities.fingerprint,
      opportunityType: schema.intelligenceOpportunities.opportunityType,
      rationale: schema.intelligenceOpportunities.rationale,
    })
    .from(schema.intelligenceOpportunities)
    .where(eq(schema.intelligenceOpportunities.clientId, clientId));

  const planned: PlannedAction[] = [];
  for (const opportunity of opportunities) {
    const action = deterministicActionFor(opportunity.opportunityType as OpportunityType);
    if (!action) continue;
    planned.push({
      clientId,
      opportunityFingerprint: opportunity.fingerprint,
      action,
      rationale: opportunity.rationale,
      source: "deterministic",
    });
  }
  return planned;
}

/** Imported lazily so unit tests never construct a Redis connection. */
async function resolveScheduler(): Promise<Scheduler> {
  const { getScheduler } = await import("../../core/scheduler.js");
  return getScheduler();
}

/**
 * Register the loop with the shared Scheduler.
 *
 * A no-op at `INTELLIGENCE_MODE=off`: no definitions, no handlers, no queues.
 * Returns the number of definitions registered so startup can log what was
 * actually turned on rather than what was compiled in.
 */
export function registerIntelligenceJobs(scheduler: Scheduler): number {
  const mode = getConfig().INTELLIGENCE_MODE;
  if (mode === "off") {
    logger.info("INTELLIGENCE_MODE=off — no intelligence jobs registered");
    return 0;
  }

  const handlers: Record<string, (job: Job) => Promise<void>> = {
    "intelligence:extract-signals": handleExtractSignals,
    "intelligence:score-opportunities": handleScoreOpportunities,
    "intelligence:plan-actions": handlePlanActions,
    "intelligence:attribute-outcomes": handleAttributeOutcomes,
  };

  for (const definition of INTELLIGENCE_JOB_DEFINITIONS) {
    scheduler.registerDefinition({ ...definition });
    scheduler.registerHandler(definition.name, handlers[definition.name]);
  }

  logger.info({ mode, count: INTELLIGENCE_JOB_DEFINITIONS.length }, "intelligence jobs registered");
  return INTELLIGENCE_JOB_DEFINITIONS.length;
}

export { scoreOpportunities } from "./opportunity-scorer.js";
export { attributeOutcomes } from "./outcome-attributor.js";
export { extractSignals } from "./signal-extractor.js";
