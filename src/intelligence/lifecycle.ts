/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Opportunity Lifecycle (ADR-0016, contract C3)
 *
 * An opportunity is a claim that something is wrong. Until this module existed
 * that claim had no ending: `status` defaulted to `open` and nothing ever moved
 * it, so the table was a growing pile of assertions with no way to tell a
 * problem that was fixed from one that is still live.
 *
 * That is not a cosmetic gap. `runner.ts` suppresses an opportunity whose
 * fingerprint is already open, and with no transition an unbounded
 * `status = 'open'` lookup matches every opportunity ever recorded — so a
 * problem acted on once and NOT actually fixed would be re-detected, re-grouped
 * to the same fingerprint, and silently discarded on every later run. The bot
 * would go quiet on exactly the problems its first remedy failed to solve. The
 * cooldown bound on that lookup was a holding measure; the transitions below are
 * the real fix.
 *
 * The states, and what moves between them:
 *
 *   open      → a live claim. The only state the duplicate check suppresses on.
 *   actioned  → a proposal has been logged for it (auto-executed or awaiting
 *               approval). Not yet known to have worked.
 *   resolved  → a linked experiment measured `improved`. Terminal.
 *   expired   → aged out with no recurrence. Terminal.
 *
 * `actioned` returns to `open` when the experiment REFUTES the remedy
 * (`declined`) or shows no effect (`unchanged`). That reopening is the point:
 * a remedy that did not work leaves the problem in place, and the next cycle
 * must be allowed to see it again and try something else. Only a measured
 * improvement closes an opportunity.
 *
 * The second half of C3 is the approved-action sweep. `evaluateExecution`
 * routes CRITICAL actions to the approval queue; an operator approves one and,
 * before this module, nothing read that approval — no outcome row, no
 * measurement window, no follow-up job. Only auto-executed actions were
 * measured, so the highest-risk changes were the least measured. The sweep gives
 * an approved action exactly what `onExecutedProposal` gives an auto-executed
 * one.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { planTemplateFor } from "./action-planner.js";
import { followUpJobBlockedReason, resolveCapabilities } from "./mode.js";
import type { ExperimentVerdict } from "./outcome-attributor.js";
import { openExperiment, type TargetMetric } from "./outcome-attributor.js";
import type { OpportunityType } from "./types.js";

const logger = createModuleLogger("intelligence:lifecycle");

/** Closed set. A status outside this set means someone wrote a typo, not a state. */
export const OPPORTUNITY_STATUSES = ["open", "actioned", "resolved", "expired"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** Statuses the duplicate-suppression lookup treats as live work. */
export const ACTIVE_OPPORTUNITY_STATUSES: readonly OpportunityStatus[] = ["open", "actioned"];

/** Terminal statuses. Nothing transitions out of these. */
export const TERMINAL_OPPORTUNITY_STATUSES: readonly OpportunityStatus[] = ["resolved", "expired"];

/**
 * Where a measured verdict leaves the opportunity it was measuring.
 *
 * Pure, so the rule that decides "did this actually close?" is testable without
 * a database — and separable from the SQL that applies it.
 */
export function statusForVerdict(verdict: ExperimentVerdict): OpportunityStatus | null {
  switch (verdict) {
    case "improved":
      // The remedy worked. This is the only verdict that closes an opportunity.
      return "resolved";
    case "declined":
    case "unchanged":
      // The remedy did not work, so the problem is still there. Reopening is
      // what lets the next cycle see it and try a different remedy, instead of
      // suppressing it forever behind an `actioned` row nobody will revisit.
      return "open";
    default:
      // Too little data to judge. Leave the opportunity where it is rather than
      // inventing a transition out of an absence of evidence.
      return null;
  }
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * Move an opportunity to `actioned` once a proposal has been logged for it.
 *
 * Guarded on `status = 'open'` so a re-run cannot walk a resolved or expired
 * opportunity backwards — BullMQ is at-least-once, and a transition that is not
 * idempotent is a transition that eventually corrupts its own history.
 */
export async function markOpportunityActioned(opportunityId: string): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(schema.intelligenceOpportunities)
    .set({ status: "actioned", updatedAt: new Date() })
    .where(
      and(
        eq(schema.intelligenceOpportunities.id, opportunityId),
        eq(schema.intelligenceOpportunities.status, "open"),
      ),
    )
    .returning({ id: schema.intelligenceOpportunities.id });
  return updated.length > 0;
}

/**
 * Apply a measured verdict to the opportunity the experiment was measuring.
 *
 * The link is experiment → decision → opportunity. An experiment with no
 * decision, or a decision with no opportunity, simply has nothing to transition:
 * that is the orphaned-FK case, and it returns `null` rather than throwing, so
 * one broken link cannot abort a whole attribution pass.
 */
export async function applyVerdictToOpportunity(
  decisionId: string | null,
  verdict: ExperimentVerdict,
): Promise<{ opportunityId: string; status: OpportunityStatus } | null> {
  if (!decisionId) return null;

  const nextStatus = statusForVerdict(verdict);
  if (!nextStatus) return null;

  const db = getDb();
  const [decision] = await db
    .select({ opportunityId: schema.intelligenceDecisions.opportunityId })
    .from(schema.intelligenceDecisions)
    .where(eq(schema.intelligenceDecisions.id, decisionId))
    .limit(1);

  const opportunityId = decision?.opportunityId;
  if (!opportunityId) return null;

  // Only an `actioned` opportunity is awaiting a verdict. Guarding on it keeps
  // a late or duplicate measurement from reopening something already resolved.
  const updated = await db
    .update(schema.intelligenceOpportunities)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(
      and(
        eq(schema.intelligenceOpportunities.id, opportunityId),
        eq(schema.intelligenceOpportunities.status, "actioned"),
      ),
    )
    .returning({ id: schema.intelligenceOpportunities.id });

  if (updated.length === 0) return null;

  logger.info({ opportunityId, verdict, status: nextStatus }, "Opportunity status updated");
  return { opportunityId, status: nextStatus };
}

/**
 * Expire opportunities that aged out without recurring.
 *
 * "Recurrence" is a newer row carrying the same (client_id, fingerprint): every
 * run re-derives opportunities from the signals it extracted, so a problem that
 * is still real produces the same fingerprint again. No newer row means the
 * extractors stopped seeing it — the claim went stale on its own, which is a
 * different thing from having been fixed, and `expired` says so honestly rather
 * than crediting the bot with a `resolved`.
 *
 * The age threshold must exceed `INTELLIGENCE_SIGNAL_COOLDOWN_DAYS`: within the
 * cooldown, a signal is suppressed and no new opportunity row is written, so an
 * expiry window shorter than the cooldown would read normal suppression as
 * absence and expire live problems. `assertLifecycleConfig` proves that.
 */
export async function expireStaleOpportunities(
  now: Date = new Date(),
  expiryDays: number = getConfig().INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - expiryDays * 86_400_000);

  // Self-referencing NOT EXISTS: inside an UPDATE the target table is addressed
  // unaliased, so the correlated columns below resolve to the row being tested.
  const expired = await db
    .update(schema.intelligenceOpportunities)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        inArray(schema.intelligenceOpportunities.status, [...ACTIVE_OPPORTUNITY_STATUSES]),
        lt(schema.intelligenceOpportunities.updatedAt, cutoff),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${schema.intelligenceOpportunities} newer
          WHERE newer.client_id = ${schema.intelligenceOpportunities.clientId}
            AND newer.fingerprint = ${schema.intelligenceOpportunities.fingerprint}
            AND newer.created_at > ${cutoff}
        )`,
      ),
    )
    .returning({ id: schema.intelligenceOpportunities.id });

  if (expired.length > 0) {
    logger.info({ expired: expired.length, expiryDays }, "Stale opportunities expired");
  }
  return expired.length;
}

// ─── Approved-action sweep ───────────────────────────────────────────────────

export interface ApprovedActionPickup {
  readonly actionLogId: string;
  readonly clientId: string;
  readonly opportunityId: string | null;
  readonly decisionId: string;
  readonly actionOutcomeId: string;
  readonly experimentId: string | null;
  readonly followUpJobQueued: boolean;
}

interface ApprovedRow {
  readonly actionLogId: string;
  readonly clientId: string;
  readonly action: string;
  readonly module: string;
  readonly approvedAt: Date | null;
  readonly decisionId: string;
  readonly opportunityId: string | null;
  readonly opportunityType: string | null;
  readonly targetUrl: string | null;
  readonly targetKeyword: string | null;
  readonly evidence: unknown;
}

/**
 * Approved, intelligence-originated actions that have not yet been picked up.
 *
 * The join through `intelligence_decisions.action_log_id` is deliberate: it is
 * what makes an action *this plane's* to measure. A sweep keyed on
 * `action_log.status = 'approved'` alone would also claim approvals belonging to
 * other modules and open measurement windows nobody asked for.
 */
async function loadApprovedActions(limit: number): Promise<ApprovedRow[]> {
  const db = getDb();
  return db
    .select({
      actionLogId: schema.actionLog.id,
      clientId: schema.actionLog.clientId,
      action: schema.actionLog.action,
      module: schema.actionLog.module,
      approvedAt: schema.actionLog.approvedAt,
      decisionId: schema.intelligenceDecisions.id,
      opportunityId: schema.intelligenceDecisions.opportunityId,
      opportunityType: schema.intelligenceOpportunities.opportunityType,
      targetUrl: schema.intelligenceOpportunities.targetUrl,
      targetKeyword: schema.intelligenceOpportunities.targetKeyword,
      evidence: schema.intelligenceOpportunities.evidence,
    })
    .from(schema.actionLog)
    .innerJoin(
      schema.intelligenceDecisions,
      eq(schema.intelligenceDecisions.actionLogId, schema.actionLog.id),
    )
    .leftJoin(
      schema.intelligenceOpportunities,
      eq(schema.intelligenceOpportunities.id, schema.intelligenceDecisions.opportunityId),
    )
    .where(
      and(
        eq(schema.actionLog.status, "approved"),
        // The claim marker. Set once the sweep has opened the window, so a
        // retried sweep re-reads nothing it already handled.
        isNull(schema.actionLog.executedAt),
      ),
    )
    .limit(limit);
}

/**
 * Claim one approved action by stamping `executed_at`, conditional on it still
 * being unstamped.
 *
 * Claim-then-act, not act-then-mark: two concurrent sweeps (or one retried by
 * BullMQ) would otherwise both pass the `IS NULL` read and each open a
 * measurement window, double-counting the same change. Only the update that
 * actually returns a row proceeds.
 */
async function claimApprovedAction(actionLogId: string, at: Date): Promise<boolean> {
  const db = getDb();
  const claimed = await db
    .update(schema.actionLog)
    .set({ executedAt: at, executionResult: "intelligence: measurement window opened" })
    .where(and(eq(schema.actionLog.id, actionLogId), isNull(schema.actionLog.executedAt)))
    .returning({ id: schema.actionLog.id });
  return claimed.length > 0;
}

/**
 * Which entity a metric is measured against, reconstructed from the STORED
 * opportunity row rather than an in-memory `ScoredOpportunity`.
 *
 * The sweep runs long after the run that produced the opportunity, so the
 * signals are only available as the `evidence` JSON the scorer wrote. Citation
 * rate is measured per platform, and the platform lives on a signal — hence the
 * walk into `evidence.signals`.
 */
export function attributionEntityFromStored(
  metric: TargetMetric,
  row: { targetKeyword: string | null; targetUrl: string | null; evidence: unknown },
): string | null {
  if (metric === "serp_position") return row.targetKeyword;
  if (metric === "page_exit_rate") return row.targetUrl;

  const signals = (row.evidence as { signals?: unknown })?.signals;
  if (!Array.isArray(signals)) return null;
  for (const signal of signals) {
    const platform = (signal as { evidence?: { platform?: unknown } })?.evidence?.platform;
    if (typeof platform === "string" && platform.trim() !== "") return platform;
  }
  return null;
}

/**
 * Give every newly-approved action what an auto-executed one already gets: an
 * `action_outcomes` row, an attribution window, and its follow-up job.
 *
 * Ordering matters and mirrors `onExecutedProposal`: claim, then outcome row,
 * then experiment (so it always references a real outcome), then the job. A
 * failure on one action is logged and skipped rather than aborting the sweep —
 * the remaining approvals are independent and should not wait on it.
 */
export async function sweepApprovedActions(
  scheduler?: Scheduler,
  now: Date = new Date(),
  limit = 50,
): Promise<ApprovedActionPickup[]> {
  const db = getDb();
  const config = getConfig();
  const capabilities = resolveCapabilities({
    mode: config.INTELLIGENCE_MODE,
    llmPlanningEnabled: config.INTELLIGENCE_LLM_PLANNING_ENABLED,
    allowOutreachRouting: config.INTELLIGENCE_ALLOW_OUTREACH_ROUTING,
    allowSiteMutation: config.INTELLIGENCE_ALLOW_SITE_MUTATION,
  });
  const rows = await loadApprovedActions(limit);
  const pickups: ApprovedActionPickup[] = [];

  for (const row of rows) {
    try {
      if (!(await claimApprovedAction(row.actionLogId, now))) continue;

      // Approval time, not sweep time, is when the operator authorized the
      // change. Measuring from the sweep would shift every window by however
      // long the approval sat unread.
      const executedAt = row.approvedAt ?? now;

      const [outcome] = await db
        .insert(schema.actionOutcomes)
        .values({
          clientId: row.clientId,
          module: row.module,
          action: row.action,
          executedAt,
        })
        .returning({ id: schema.actionOutcomes.id });

      const template = row.opportunityType
        ? planTemplateFor(row.opportunityType as OpportunityType)
        : null;

      let experimentId: string | null = null;
      const entityId = template
        ? attributionEntityFromStored(template.targetMetric, {
            targetKeyword: row.targetKeyword,
            targetUrl: row.targetUrl,
            evidence: row.evidence,
          })
        : null;

      if (template && entityId) {
        experimentId = await openExperiment({
          clientId: row.clientId,
          decisionId: row.decisionId,
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
        // The outcome row still exists, so the approval is recorded; it simply
        // has no metric to be judged against. Saying so is better than opening a
        // window that can only ever return `inconclusive`.
        logger.warn(
          { actionLogId: row.actionLogId, opportunityType: row.opportunityType },
          "Approved action has no attribution entity — recorded without a measurement window",
        );
      }

      // The measurement above is unconditional: an operator approved this action,
      // and C3 exists so an approved action is measured like an auto-executed
      // one. The rollout gate applies only to the QUEUE — whether this
      // environment may yet reach the outside world on the bot's behalf.
      let followUpJobQueued = false;
      if (template?.followUpJob && scheduler) {
        const blocked = followUpJobBlockedReason(template.followUpJob, capabilities);
        if (blocked) {
          logger.info(
            { job: template.followUpJob, reason: blocked, mode: capabilities.mode },
            "Approved action's follow-up job withheld by rollout gate",
          );
        } else {
          // Keyed on the outcome row, which the conditional `executed_at` claim
          // above created exactly once for this approval. A retried sweep
          // re-queues nothing.
          await scheduler.addJob(
            template.followUpJob,
            { clientId: row.clientId },
            { jobId: `intel:${row.clientId}:${outcome.id}:${template.followUpJob}` },
          );
          followUpJobQueued = true;
        }
      }

      if (row.opportunityId) await markOpportunityActioned(row.opportunityId);

      pickups.push({
        actionLogId: row.actionLogId,
        clientId: row.clientId,
        opportunityId: row.opportunityId,
        decisionId: row.decisionId,
        actionOutcomeId: outcome.id,
        experimentId,
        followUpJobQueued,
      });

      logger.info(
        { actionLogId: row.actionLogId, clientId: row.clientId, experimentId },
        "Approved action picked up for measurement",
      );
    } catch (error) {
      logger.error(
        {
          actionLogId: row.actionLogId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Approved-action pickup failed",
      );
    }
  }

  return pickups;
}

// ─── Config invariant ────────────────────────────────────────────────────────

/**
 * Expiry must outlast the signal cooldown.
 *
 * Inside the cooldown a repeat observation is suppressed and writes no new
 * opportunity row, so an expiry window shorter than the cooldown would read
 * ordinary suppression as "the problem went away" and expire live work. Checked
 * at registration rather than left as a comment, because the two values are set
 * independently by environment and nothing else would notice them crossing.
 */
export function assertLifecycleConfig(config: {
  INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: number;
  INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: number;
}): void {
  if (config.INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS <= config.INTELLIGENCE_SIGNAL_COOLDOWN_DAYS) {
    throw new Error(
      `INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS (${config.INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS}) must ` +
        `exceed INTELLIGENCE_SIGNAL_COOLDOWN_DAYS (${config.INTELLIGENCE_SIGNAL_COOLDOWN_DAYS}); ` +
        "otherwise ordinary signal suppression is mistaken for the problem going away and live " +
        "opportunities expire.",
    );
  }
}
