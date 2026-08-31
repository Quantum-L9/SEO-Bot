/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Policy State Refresh (ADR-0016)
 *
 * The autonomous governors — LLM budget, outreach velocity, ranking circuit
 * breaker — as SQL-readable rows instead of checks scattered across modules.
 *
 * Each is computed from the SAME source the enforcing module uses:
 *   - outreach headroom via `velocityRunLimit` and `LINK_VELOCITY`, the exact
 *     function and caps `links:process-outreach` enforces;
 *   - LLM headroom from `llm_usage` against the configured caps;
 *   - the circuit breaker at `circuitBreakerDropPct`, the threshold the
 *     link-building module already treats as "something systemic happened".
 *
 * Recomputing a governor here with different numbers would produce a plane that
 * reasons about a system it is not actually part of.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { eq, sql } from "drizzle-orm";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import { LINK_VELOCITY, velocityRunLimit } from "../modules/link-building/velocity.js";
import { defaultPolicyState, type PolicyState } from "./policy-engine.js";
import { asNumber } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:policy-state");

/**
 * Share of tracked keywords that must decline within a week before the ranking
 * circuit breaker opens. Mirrors link-building's `circuitBreakerDropPct: 30`.
 */
export const CIRCUIT_BREAKER_DECLINE_PCT = 30;

/** Below this many tracked keywords, a decline share is noise, not a signal. */
export const CIRCUIT_BREAKER_MIN_KEYWORDS = 5;

/** Whole days left in the current month, including today. Always at least 1. */
export function daysRemainingInMonth(now: Date): number {
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Math.max(1, daysInMonth - now.getUTCDate() + 1);
}

/**
 * Daily LLM headroom in USD.
 *
 * With an explicit daily cap, that cap minus today's spend. Without one, the
 * month's remaining budget pro-rated across the days left — which is a real
 * daily allowance rather than a monthly figure wearing a daily name. Never
 * negative: overspend is zero headroom, not a debt to work off.
 */
export function computeDailyLlmHeadroom(input: {
  dailyCapUsd: number | undefined;
  todaySpendUsd: number;
  monthlyBudgetUsd: number;
  monthToDateSpendUsd: number;
  daysRemaining: number;
}): number {
  if (input.dailyCapUsd !== undefined && input.dailyCapUsd > 0) {
    return Math.max(0, input.dailyCapUsd - input.todaySpendUsd);
  }
  const monthRemaining = Math.max(0, input.monthlyBudgetUsd - input.monthToDateSpendUsd);
  return Math.max(0, monthRemaining / Math.max(1, input.daysRemaining));
}

/** True when enough of a client's tracked keywords declined to distrust attribution. */
export function isCircuitOpen(declined: number, tracked: number): boolean {
  if (tracked < CIRCUIT_BREAKER_MIN_KEYWORDS) return false;
  return (declined / tracked) * 100 >= CIRCUIT_BREAKER_DECLINE_PCT;
}

/**
 * Recompute and persist one client's governor state.
 *
 * The manual pause switch (`autonomous_actions_paused` / `pause_reason`) is an
 * OPERATOR control and is never overwritten here — a refresh that silently
 * un-pauses a client the operator paused would make the switch worthless.
 */
export async function refreshPolicyState(clientId: string): Promise<PolicyState> {
  const db = getDb();
  const config = getConfig();
  const now = new Date();

  const result = await db.execute(sql`
    SELECT
      (SELECT COALESCE(sum(cost), 0) FROM llm_usage
        WHERE client_id = ${clientId}::uuid AND timestamp >= date_trunc('day', now())) AS today_spend,
      (SELECT COALESCE(sum(cost), 0) FROM llm_usage
        WHERE client_id = ${clientId}::uuid AND timestamp >= date_trunc('month', now())) AS month_spend,
      (SELECT count(*) FROM link_prospects
        WHERE client_id = ${clientId}::uuid AND status = 'outreach_queued'
          AND updated_at >= now() - interval '7 days') AS outreach_sent_this_week,
      (SELECT count(*) FROM serp_rankings
        WHERE client_id = ${clientId}::uuid AND checked_at >= now() - interval '7 days'
          AND position IS NOT NULL AND previous_position IS NOT NULL) AS tracked_keywords,
      (SELECT count(*) FROM serp_rankings
        WHERE client_id = ${clientId}::uuid AND checked_at >= now() - interval '7 days'
          AND position IS NOT NULL AND previous_position IS NOT NULL
          AND position > previous_position) AS declined_keywords
  `);
  const row = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0] ?? {};

  const dailyLlmBudgetRemaining = computeDailyLlmHeadroom({
    dailyCapUsd: config.DAILY_SPEND_CAP,
    todaySpendUsd: asNumber(row.today_spend) ?? 0,
    monthlyBudgetUsd: config.DEFAULT_CLIENT_MONTHLY_BUDGET,
    monthToDateSpendUsd: asNumber(row.month_spend) ?? 0,
    daysRemaining: daysRemainingInMonth(now),
  });

  const outreachCapacityRemaining = velocityRunLimit(
    asNumber(row.outreach_sent_this_week) ?? 0,
    LINK_VELOCITY.maxLinksPerWeek,
    LINK_VELOCITY.maxEmailsPerDay,
  );

  const rankingCircuitOpen = isCircuitOpen(
    asNumber(row.declined_keywords) ?? 0,
    asNumber(row.tracked_keywords) ?? 0,
  );

  const computed = {
    dailyLlmBudgetRemaining: dailyLlmBudgetRemaining.toFixed(6),
    outreachCapacityRemaining,
    rankingCircuitOpen,
    updatedAt: now,
  };

  const [persisted] = await db
    .insert(schema.intelligencePolicyState)
    .values({ clientId, ...computed })
    .onConflictDoUpdate({
      target: schema.intelligencePolicyState.clientId,
      // Note the absent pause fields: the operator's switch survives a refresh.
      set: computed,
    })
    .returning();

  logger.debug(
    { clientId, dailyLlmBudgetRemaining, outreachCapacityRemaining, rankingCircuitOpen },
    "Policy state refreshed",
  );

  return {
    autonomousActionsPaused: persisted?.autonomousActionsPaused ?? false,
    pauseReason: persisted?.pauseReason ?? null,
    dailyLlmBudgetRemaining,
    outreachCapacityRemaining,
    rankingCircuitOpen,
  };
}

/** Read the stored state without recomputing it. Missing row → permissive default. */
export async function loadPolicyState(clientId: string): Promise<PolicyState> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.intelligencePolicyState)
    .where(eq(schema.intelligencePolicyState.clientId, clientId))
    .limit(1);

  if (!row) return defaultPolicyState();

  return {
    autonomousActionsPaused: row.autonomousActionsPaused,
    pauseReason: row.pauseReason,
    dailyLlmBudgetRemaining: asNumber(row.dailyLlmBudgetRemaining),
    outreachCapacityRemaining: row.outreachCapacityRemaining,
    rankingCircuitOpen: row.rankingCircuitOpen,
  };
}
