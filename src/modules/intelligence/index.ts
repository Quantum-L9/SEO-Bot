/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Module 6: Intelligence Control Loop
 *
 * Observes -> scores -> decides -> routes -> attributes.
 *
 * THE PHASES ARE SEPARATE JOBS ON PURPose.
 * extract / score / plan / attribute could be one handler. They are four,
 * because each phase has a different blast radius and a different mode gate:
 * `observe` must be able to run extraction and scoring forever without ever
 * loading the code path that can enqueue work. Splitting them means a mode
 * check that fails also means the risky code never executes, rather than
 * executing and then declining to act.
 *
 * EVERY HANDLER IS MODE-GATED AND CLIENT-SCOPED.
 * A handler with no clientId throws rather than proceeding, and a handler whose
 * capability is off returns without writing. Both outcomes are recorded in
 * intelligence_runs so "nothing happened" is always explainable.
 *
 * Token budget: extract/score/attribute are 0 tokens (pure SQL + arithmetic).
 * Only `intelligence:plan-actions` spends, and only in route_llm/full.
 */

import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "../../core/config.js";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import type { Scheduler } from "../../core/scheduler.js";
import { getLlmService } from "../../services/llm.js";
import { routeOpportunity } from "./action-router.js";
import { buildEvidencePack } from "./evidence-pack.js";
import {
  currentIntelligenceFlags,
  currentIntelligenceMode,
  type IntelligenceMode,
  resolveCapabilities,
} from "./modes.js";
import {
  persistOpportunities,
  type ScoredOpportunity,
  scoreOpportunities,
} from "./opportunity-scorer.js";
import { attributeOutcomes } from "./outcome-attributor.js";
import { allowedActionsForMode, planActions } from "./planner.js";
import { evaluateIntelligenceAction, requireClientId } from "./policy-gate.js";
import { type ExtractedSignal, extractSignals } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence");

// ─── Run bookkeeping ─────────────────────────────────────────────────────────

async function startRun(
  clientId: string,
  runType: string,
  mode: IntelligenceMode,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.intelligenceRuns)
    .values({ clientId, runType, mode, status: "running" })
    .returning({ id: schema.intelligenceRuns.id });
  return row.id;
}

async function finishRun(
  runId: string,
  status: "completed" | "failed" | "skipped",
  stats: Record<string, unknown>,
  error?: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.intelligenceRuns)
    .set({ status, stats, error: error ?? null, completedAt: new Date() })
    .where(eq(schema.intelligenceRuns.id, runId));
}

/**
 * Wrap a phase so every outcome - success, skip, and failure - lands in
 * intelligence_runs. A phase that throws must still close its row, otherwise a
 * crashed run is indistinguishable from one still in flight.
 */
async function withRun<T>(
  clientId: string,
  runType: string,
  mode: IntelligenceMode,
  fn: (runId: string) => Promise<{ result: T; stats: Record<string, unknown> }>,
): Promise<T> {
  const runId = await startRun(clientId, runType, mode);
  try {
    const { result, stats } = await fn(runId);
    await finishRun(runId, "completed", stats);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, "failed", {}, message);
    logger.error({ clientId, runType, err: message }, "Intelligence phase failed");
    throw error;
  }
}

function jobClientId(job: Job): string {
  return requireClientId((job.data as { clientId?: string }).clientId);
}

// ─── Phase 1: extract signals ────────────────────────────────────────────────

export async function extractSignalsHandler(job: Job): Promise<void> {
  const clientId = jobClientId(job);
  const mode = currentIntelligenceMode();
  const capabilities = resolveCapabilities(mode, currentIntelligenceFlags());

  if (!capabilities.writesSignals) {
    logger.info({ clientId, mode }, "Signal extraction skipped - mode does not permit it");
    return;
  }

  await withRun(clientId, "extract_signals", mode, async () => {
    const { signals, persisted } = await extractSignals(clientId);
    return { result: undefined, stats: { signals: signals.length, ...persisted } };
  });
}

// ─── Phase 2: score opportunities ────────────────────────────────────────────

export async function scoreOpportunitiesHandler(job: Job): Promise<void> {
  const clientId = jobClientId(job);
  const mode = currentIntelligenceMode();
  const config = getConfig();
  const capabilities = resolveCapabilities(mode, currentIntelligenceFlags());

  if (!capabilities.writesOpportunities) {
    logger.info({ clientId, mode }, "Scoring skipped - mode does not permit it");
    return;
  }

  await withRun(clientId, "score_opportunities", mode, async () => {
    const opportunities = await scoreOpportunities(clientId, {
      staleDays: config.INTELLIGENCE_SIGNAL_STALE_DAYS,
    });
    const persisted = await persistOpportunities(opportunities);
    return {
      result: undefined,
      stats: { opportunities: opportunities.length, persisted: persisted.length },
    };
  });
}

// ─── Phase 3: plan + route ───────────────────────────────────────────────────

/**
 * Decide and route.
 *
 * In `recommend` this writes proposals and nothing else; in `route_safe` it
 * additionally enqueues read-only jobs; only in `route_llm`/`full` does the
 * planner run at all. The LLM is consulted AFTER deterministic scoring has
 * already chosen the candidate set, so a planner failure degrades to
 * "no actions this run" rather than to "no intelligence this run".
 */
export async function planActionsHandler(job: Job): Promise<void> {
  const clientId = jobClientId(job);
  const mode = currentIntelligenceMode();
  const config = getConfig();
  const capabilities = resolveCapabilities(mode, currentIntelligenceFlags());
  const db = getDb();

  if (!capabilities.writesProposals) {
    logger.info({ clientId, mode }, "Planning skipped - mode does not permit proposals");
    return;
  }

  await withRun(clientId, "plan_actions", mode, async () => {
    const [client] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    const gateClient = client ? { id: client.id, active: client.active } : null;

    const opportunityRows = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(
        and(
          eq(schema.intelligenceOpportunities.clientId, clientId),
          eq(schema.intelligenceOpportunities.status, "open"),
        ),
      )
      .orderBy(sql`${schema.intelligenceOpportunities.score} DESC`)
      .limit(config.INTELLIGENCE_MAX_ROUTED_PER_RUN);

    if (opportunityRows.length === 0) {
      return { result: undefined, stats: { opportunities: 0, routed: 0 } };
    }

    const opportunities: Array<ScoredOpportunity & { id: string }> = opportunityRows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      opportunityType: row.opportunityType as ScoredOpportunity["opportunityType"],
      fingerprint: row.fingerprint,
      score: row.score,
      impact: row.impact,
      confidence: row.confidence,
      effort: row.effort,
      risk: row.risk,
      signalFingerprints: (row.signalFingerprints ?? []) as string[],
      rationale: row.rationale ?? "",
    }));

    // The planner is advisory: its output narrows which opportunities get
    // routed. If it fails validation the run still completes, having routed
    // nothing - which is the safe direction.
    let plannedTypes: Set<string> | null = null;
    let llmUsed = false;
    if (capabilities.usesLlmPlanner && client) {
      const signalRows = await db
        .select()
        .from(schema.intelligenceSignals)
        .where(eq(schema.intelligenceSignals.clientId, clientId))
        .limit(500);

      const signalsByFingerprint = new Map<string, ExtractedSignal>(
        signalRows.map((row) => [
          row.fingerprint,
          {
            clientId: row.clientId,
            signalType: row.signalType as ExtractedSignal["signalType"],
            fingerprint: row.fingerprint,
            entityKey: row.entityKey,
            severity: row.severity as ExtractedSignal["severity"],
            strength: row.strength ?? 0,
            evidence: (row.evidence ?? {}) as Record<string, unknown>,
          },
        ]),
      );

      const allowedActions = allowedActionsForMode(mode);
      const pack = buildEvidencePack({
        clientId,
        clientDomain: client.domain,
        industry: client.industry,
        mode,
        allowedActions,
        opportunities,
        signalsByFingerprint,
      });

      const llm = getLlmService();
      try {
        const plan = await planActions(
          pack,
          {
            strategizeJson: (args) =>
              llm.strategizeJson({
                clientId: args.clientId,
                module: "intelligence",
                purpose: args.purpose,
                systemPrompt: args.systemPrompt,
                userPrompt: args.userPrompt,
                validate: args.validate,
              }),
          },
          allowedActions,
        );
        llmUsed = true;
        plannedTypes = new Set(plan.actions.map((action) => action.opportunityType));
      } catch (error) {
        logger.warn(
          { clientId, err: error instanceof Error ? error.message : String(error) },
          "Planner unavailable or rejected - routing nothing this run",
        );
        return {
          result: undefined,
          stats: {
            opportunities: opportunities.length,
            routed: 0,
            llmUsed: false,
            plannerRejected: true,
          },
        };
      }
    }

    // Imported lazily: core/scheduler imports this module's registrar, so a
    // top-level import here would close an import cycle.
    const { getScheduler } = await import("../../core/scheduler.js");
    const scheduler = getScheduler();

    let routed = 0;
    let blocked = 0;

    for (const opportunity of opportunities) {
      if (plannedTypes && !plannedTypes.has(opportunity.opportunityType)) continue;

      const results = await routeOpportunity(opportunity, {
        scheduler,
        clientDomain: client?.domain ?? "",
        clientConfig: client?.config ?? {},
        writesProposals: capabilities.writesProposals,
        recordLink: async (link) => {
          const inserted = await db
            .insert(schema.intelligenceActionLinks)
            .values(link)
            .onConflictDoNothing({
              target: [
                schema.intelligenceActionLinks.clientId,
                schema.intelligenceActionLinks.opportunityId,
                schema.intelligenceActionLinks.jobName,
              ],
            })
            .returning({ id: schema.intelligenceActionLinks.id });
          return inserted.length > 0;
        },
        // The gate derives outreach/mutation classification from the action
        // name itself, so the router's `outreach` hint is not forwarded - one
        // source of truth for what an action is, not two that can disagree.
        evaluate: (action) =>
          evaluateIntelligenceAction({
            clientId,
            action,
            mode,
            capabilities,
            client: gateClient,
            requiresLlm: false,
            // ROUTE_MAP never routes `intelligence_execute_site_change`, so no
            // live-mutation path reaches this gate today. These are passed
            // explicitly at their safe values rather than omitted, so that
            // adding such a route later fails closed here instead of
            // inheriting `undefined` and reading as "not blocked".
            siteDeploymentReady: false,
            siteDeployDryRun: true,
            // Wired to their real sources when the corresponding governors
            // expose a per-client query; until then the conservative value is
            // the correct one, because it can only block, never permit.
            outreachVelocityExhausted: false,
            rankingCircuitBreakerOpen: false,
            llmBudgetExhausted: false,
          }),
      });

      routed += results.filter((r) => r.outcome === "queued").length;
      blocked += results.filter((r) => r.outcome === "blocked").length;
    }

    return {
      result: undefined,
      stats: { opportunities: opportunities.length, routed, blocked, llmUsed },
    };
  });
}

// ─── Phase 4: attribute outcomes ─────────────────────────────────────────────

export async function attributeOutcomesHandler(job: Job): Promise<void> {
  const clientId = jobClientId(job);
  const mode = currentIntelligenceMode();
  const capabilities = resolveCapabilities(mode, currentIntelligenceFlags());

  if (!capabilities.writesSignals) {
    logger.info({ clientId, mode }, "Attribution skipped - mode does not permit it");
    return;
  }

  await withRun(clientId, "attribute_outcomes", mode, async () => {
    const results = await attributeOutcomes(clientId);
    return {
      result: undefined,
      stats: {
        measured: results.length,
        improved: results.filter((r) => r.success === true).length,
      },
    };
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerIntelligenceHandlers(scheduler: Scheduler): void {
  scheduler.registerHandler("intelligence:extract-signals", extractSignalsHandler);
  scheduler.registerHandler("intelligence:score-opportunities", scoreOpportunitiesHandler);
  scheduler.registerHandler("intelligence:plan-actions", planActionsHandler);
  scheduler.registerHandler("intelligence:attribute-outcomes", attributeOutcomesHandler);
  logger.info({ mode: getConfig().INTELLIGENCE_MODE }, "Intelligence handlers registered");
}

export * from "./action-router.js";
export * from "./evidence-pack.js";
export * from "./modes.js";
export * from "./opportunity-scorer.js";
export * from "./outcome-attributor.js";
export * from "./planner.js";
export * from "./policy-gate.js";
export * from "./signal-extractor.js";
