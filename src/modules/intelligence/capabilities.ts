/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Capability Resolution
 *
 * Resolves what the intelligence loop is permitted to do on this deployment,
 * from validated config.
 *
 * WHAT GATES WHAT, AND WHERE.
 * Config flags gate the loop's OWN behaviour: whether it runs, whether it uses
 * a model, whether it enqueues low-risk work, whether it benchmarks. They do
 * NOT gate the dangerous actions. Outreach and live-site mutation are gated by
 * the policy gate against real operational state — the link-velocity governor,
 * the ranking circuit breaker, and site-deployment readiness — plus the
 * execution-policy risk taxonomy, where site mutation is CRITICAL and therefore
 * always operator-approved.
 *
 * That split is deliberate. A boolean in a `.env` file is a poor guard for an
 * irreversible action: it says what someone intended weeks ago, not whether
 * sending this email right now is safe. The governors know the latter.
 */

import { getConfig } from "../../core/config.js";

export interface IntelligenceCapabilities {
  /** Master switch — when false nothing is scheduled and nothing is written. */
  enabled: boolean;
  /** May call the structured LLM planner. */
  usesLlmPlanner: boolean;
  /** May enqueue LOW-risk read-only analysis jobs without approval. */
  autoRouteLowRisk: boolean;
  /** May run the weekly anonymized cross-client benchmark. */
  portfolioBenchmark: boolean;
  /** Per-client ceiling on opportunities considered per planning run. */
  maxOpportunitiesPerClient: number;
  /** Opportunities below this score are never planned or routed. */
  minScoreToPlan: number;
  /** Signals not re-observed within this window stop feeding opportunities. */
  signalStaleDays: number;
}

export function resolveCapabilities(
  config: Pick<
    ReturnType<typeof getConfig>,
    | "INTELLIGENCE_ENABLED"
    | "INTELLIGENCE_LLM_PLANNING_ENABLED"
    | "INTELLIGENCE_AUTO_ROUTE_LOW_RISK"
    | "INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED"
    | "INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT"
    | "INTELLIGENCE_MIN_SCORE_TO_PLAN"
    | "INTELLIGENCE_SIGNAL_STALE_DAYS"
  >,
): IntelligenceCapabilities {
  const enabled = config.INTELLIGENCE_ENABLED === true;
  return {
    enabled,
    // Every downstream capability is ANDed with `enabled`, so the master switch
    // cannot be bypassed by setting a narrower flag. Reading these fields is
    // then sufficient — no caller has to remember to check `enabled` too.
    usesLlmPlanner: enabled && config.INTELLIGENCE_LLM_PLANNING_ENABLED === true,
    autoRouteLowRisk: enabled && config.INTELLIGENCE_AUTO_ROUTE_LOW_RISK === true,
    portfolioBenchmark: enabled && config.INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED === true,
    maxOpportunitiesPerClient: config.INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT,
    minScoreToPlan: config.INTELLIGENCE_MIN_SCORE_TO_PLAN,
    signalStaleDays: config.INTELLIGENCE_SIGNAL_STALE_DAYS,
  };
}

export function currentCapabilities(): IntelligenceCapabilities {
  return resolveCapabilities(getConfig());
}

export function isIntelligenceEnabled(): boolean {
  return getConfig().INTELLIGENCE_ENABLED === true;
}
