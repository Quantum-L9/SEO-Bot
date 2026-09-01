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
import { type ExecutionDecision, logAction } from "../core/execution-policy.js";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { type PlannedDecision, planOpportunity } from "./action-planner.js";
import { buildEvidencePack } from "./evidence-pack.js";
import { ACTIVE_OPPORTUNITY_STATUSES, markOpportunityActioned } from "./lifecycle.js";
import {
  followUpJobBlockedReason,
  type IntelligenceCapabilities,
  resolveCapabilities,
} from "./mode.js";
import { buildOpportunities } from "./opportunity-scorer.js";
import { openExperiment } from "./outcome-attributor.js";
import { loadPolicyState, refreshPolicyState } from "./policy-state.js";
import { allExtractors, applySuppression, extractSignals } from "./signal-extractor.js";
import type { ScoredOpportunity, SignalCandidate } from "./types.js";

const logger = createModuleLogger("intelligence:runner");

export type TriggerSource = "cron" | "manual" | "api";

export interface RunSummary {
  /**
   * The `intelligence_runs` row this cycle wrote, or null when the rollout mode
   * is `off` and no row was written. Null is the honest value: reporting a run
   * id for a cycle that recorded nothing would put a dangling reference in every
   * caller's log, and `off` has to be distinguishable from "ran and found none".
   */
  readonly runId: string | null;
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

  // The rollout gate's FIRST application, before any row is written.
  //
  // `off` is enforced at registration — a disabled job cannot fire — and that is
  // the path that matters in steady state. It is not the only path here: a
  // repeatable job already sitting in Redis when the operator lowered the mode
  // fires once more against the new config, an in-flight retry re-enters this
  // function after the restart, and a manual trigger calls it outright. In all
  // three the handler runs with `mode = off`, and without this check it would
  // write a run, its signals and its opportunities — which is what "rollback is
  // one environment variable plus a restart" promises it will not do.
  //
  // `reason` was defined on the capability surface for exactly this and then
  // never consulted: the plane's own warning about a gate that looks like a
  // control and is dead code, applied to itself.
  const capabilities = resolveCapabilities({
    mode: config.INTELLIGENCE_MODE,
    llmPlanningEnabled: config.INTELLIGENCE_LLM_PLANNING_ENABLED,
    allowOutreachRouting: config.INTELLIGENCE_ALLOW_OUTREACH_ROUTING,
    allowSiteMutation: config.INTELLIGENCE_ALLOW_SITE_MUTATION,
  });

  if (!capabilities.reason) {
    logger.info({ clientId, mode: capabilities.mode }, "Rollout mode is off — triage did not run");
    return {
      runId: null,
      clientId,
      signalsExtracted: 0,
      signalsSuppressed: 0,
      opportunities: 0,
      ungroupedSignals: 0,
      proposals: 0,
      autoExecuted: 0,
      queuedForApproval: 0,
      jobsQueued: 0,
      extractorFailures: 0,
    };
  }

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

    const summary = await executeCycle(runId, client, config, scheduler, capabilities);

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
  capabilities: IntelligenceCapabilities,
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
  // The rollout gate. In `observe` the plane has done its whole job by here:
  // signals and opportunities are on record and an operator can read what the
  // bot would have reasoned about, having proposed nothing and queued nothing.
  //
  // Returning early rather than looping-and-skipping is deliberate: it means an
  // observe-mode run cannot write an action_log row, a decision row or an
  // experiment even if a later edit adds a write inside that loop.
  if (!capabilities.propose) {
    logger.info(
      { clientId, mode: capabilities.mode, opportunities: opportunities.length },
      "Observe mode — opportunities recorded, no proposals made",
    );
    return {
      runId,
      clientId,
      signalsExtracted: kept.length,
      signalsSuppressed: suppressed.length,
      opportunities: opportunities.length,
      ungroupedSignals: ungrouped.length,
      proposals: 0,
      autoExecuted: 0,
      queuedForApproval: 0,
      jobsQueued: 0,
      extractorFailures: failures.length,
    };
  }

  const policyState = await refreshPolicyState(clientId);
  const openFingerprints = await loadOpenOpportunityFingerprints(clientId, runId);

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

    // Apply the rollout gate BEFORE logging, not after. `action_log` is the
    // operator's record of what the bot did; writing "auto-executed" there and
    // then declining to execute would make a withheld action indistinguishable
    // from a performed one — the same class of healthy-looking-but-false state
    // the lifecycle contract (C3) exists to prevent.
    const execution = gateExecution(planned, capabilities);

    const actionLogId = planned.proposal
      ? await logAction(
          planned.proposal,
          execution ?? { execute: false, reason: "", requiresApproval: true },
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
          execution_policy: execution
            ? { execute: execution.execute, reason: execution.reason }
            : null,
        },
        evidenceSummary: evidencePack as unknown as Record<string, unknown>,
        requiresApproval: execution?.requiresApproval ?? false,
        actionLogId,
      })
      .returning({ id: schema.intelligenceDecisions.id });

    if (!planned.proposal || !planned.template) continue;

    proposals += 1;
    actionsTaken += 1;

    // A proposal exists for this opportunity, so it is no longer merely `open`.
    // The transition happens whether the execution policy auto-executed it or
    // parked it for approval: in both cases the bot has committed a remedy and
    // must not re-propose the same one next cycle. What separates them is
    // measurement, below — and, for the approval path, the lifecycle sweep.
    const opportunityId = opportunityIds.get(opportunity.fingerprint);
    if (opportunityId) await markOpportunityActioned(opportunityId);

    if (execution?.execute) {
      autoExecuted += 1;
      jobsQueued += await onExecutedProposal(
        planned,
        opportunity,
        config,
        scheduler,
        decisionRow?.id ?? null,
        capabilities,
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
 * Apply the rollout gate to the execution policy's decision.
 *
 * The policy decides what is SAFE to do; the rollout mode decides how much of
 * that the operator has switched on yet. They are separate questions, so this
 * narrows the policy's answer rather than replacing it — a decision the policy
 * already withheld stays withheld, with the policy's own reason intact.
 *
 * A gated action becomes `requiresApproval`, which is the honest destination:
 * the bot still believes the action is right, and an operator can approve it by
 * hand. The lifecycle sweep (C3) then measures it exactly as it measures any
 * other approved action.
 */
function gateExecution(
  planned: PlannedDecision,
  capabilities: IntelligenceCapabilities,
): ExecutionDecision | null {
  const execution = planned.execution;
  // Nothing to narrow: the policy already declined, or there is no proposal.
  if (!execution?.execute) return execution;

  const followUpJob = planned.template?.followUpJob ?? null;
  const blocked = !capabilities.route
    ? `rollout mode '${capabilities.mode}' records proposals but does not execute them`
    : followUpJob
      ? followUpJobBlockedReason(followUpJob, capabilities)
      : null;

  if (!blocked) return execution;

  return {
    execute: false,
    reason: `Withheld by rollout gate: ${blocked}. Policy would have executed: ${execution.reason}`,
    requiresApproval: true,
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
  capabilities: IntelligenceCapabilities,
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

  // Second check, after the gate that already ran in `gateExecution`. This one
  // guards the queue itself rather than the decision, so a future caller that
  // reaches this function by another path cannot route outreach without the flag.
  const blocked = followUpJobBlockedReason(template.followUpJob, capabilities);
  if (blocked) {
    logger.info(
      { job: template.followUpJob, reason: blocked, mode: capabilities.mode },
      "Follow-up job withheld by rollout gate",
    );
    return 0;
  }

  // Deterministic job id, keyed on the OPPORTUNITY's fingerprint rather than on
  // the outcome row.
  //
  // The outcome row is inserted fresh on every pass, so keying on its id gave a
  // different key each time and deduplicated nothing — which is the one thing a
  // dedup key exists to do. The fingerprint is stable across runs by
  // construction (client + type + target), so a BullMQ retry of this handler and
  // two runs racing the same opportunity both produce the same key and BullMQ
  // collapses them. That second case is the one status suppression does not
  // cover: two concurrent runs each load the open fingerprints before either
  // marks the opportunity actioned, so both propose, and without a stable key
  // both would send the same outreach.
  //
  // It does not block a legitimate recurrence later: the queue retains only the
  // last 100 completed jobs, so the key is forgotten long before an expired
  // opportunity could come back — and while it IS remembered, suppression means
  // a second enqueue would be a duplicate by definition.
  await scheduler.addJob(
    template.followUpJob,
    { clientId: opportunity.clientId },
    { jobId: `intel:${opportunity.clientId}:${opportunity.fingerprint}:${template.followUpJob}` },
  );
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
 * Fingerprints of this client's LIVE opportunities, excluding the ones this run
 * just wrote — otherwise every opportunity would suppress itself.
 *
 * "Live" is `open` or `actioned` (contract C3). Before the lifecycle existed,
 * `status` never transitioned, so an unbounded `status = 'open'` filter matched
 * every opportunity ever recorded and suppression was PERMANENT: a problem acted
 * on once and not actually fixed would be re-detected, re-grouped into the same
 * fingerprint, and silently discarded on every later run. The cooldown bound
 * that used to sit here was a holding measure against exactly that.
 *
 * It is gone now because status carries the meaning instead, and carries it
 * better: a `resolved` or `expired` opportunity no longer suppresses anything,
 * while an `actioned` one whose remedy is still being measured correctly does —
 * a bound on age could only ever approximate that distinction.
 */
async function loadOpenOpportunityFingerprints(
  clientId: string,
  runId: string,
): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ fingerprint: schema.intelligenceOpportunities.fingerprint })
    .from(schema.intelligenceOpportunities)
    .where(
      and(
        eq(schema.intelligenceOpportunities.clientId, clientId),
        inArray(schema.intelligenceOpportunities.status, [...ACTIVE_OPPORTUNITY_STATUSES]),
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
