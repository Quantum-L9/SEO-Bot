/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Policy Engine (ADR-0016)
 *
 * Self-sustaining does not mean self-authorizing.
 *
 * The bot may discover, diagnose, prioritize, plan, measure, and learn on its
 * own. Every path from an opportunity to a mutation still passes through this
 * gate first, and then through the existing execution policy, budget ceilings,
 * approval queue, and module allow-list. This function widens nothing: it can
 * only refuse, and returning `propose_action` means "continue to the existing
 * gates", never "execute".
 *
 * Pure and synchronous. The governors it reads (pause switch, ranking circuit
 * breaker, outreach velocity, LLM budget) live in `intelligence_policy_state` as
 * SQL-readable rows rather than as checks scattered across five modules.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { DecisionKind, OpportunityType } from "./types.js";

export interface PolicyState {
  readonly autonomousActionsPaused: boolean;
  readonly pauseReason: string | null;
  /** USD remaining today. `null` means unknown — treated as unknown, not as plenty. */
  readonly dailyLlmBudgetRemaining: number | null;
  /** Outreach sends still permitted by the velocity governor. `null` = unknown. */
  readonly outreachCapacityRemaining: number | null;
  readonly rankingCircuitOpen: boolean;
}

export interface PolicyContext {
  readonly clientActive: boolean;
  readonly opportunityType: OpportunityType;
  readonly opportunityScore: number;
  readonly minScore: number;
  /** True when the planned next step spends tokens. */
  readonly requiresLlm: boolean;
  /** True when the planned next step sends outreach to a third party. */
  readonly isOutreach: boolean;
  /** True when this opportunity's fingerprint is already open or suppressed. */
  readonly duplicateOfOpenWork: boolean;
  readonly actionsTakenThisRun: number;
  readonly maxActionsPerRun: number;
}

export interface PolicyVerdict {
  readonly decision: DecisionKind;
  readonly allowed: boolean;
  readonly rationale: string;
  /** Machine-readable basis, persisted on the decision row. */
  readonly blockers: readonly string[];
}

/** Opportunity types whose remedy is diagnosis, not a site change. */
const DIAGNOSTIC_ONLY: ReadonlySet<OpportunityType> = new Set(["pipeline_repair", "budget_review"]);

/**
 * Evaluate one opportunity against policy.
 *
 * Checks are ordered from most to least fundamental so the rationale names the
 * real reason: an inactive client is not "below threshold", it is out of scope.
 */
export function evaluatePolicy(state: PolicyState, context: PolicyContext): PolicyVerdict {
  const blockers: string[] = [];

  if (!context.clientActive) {
    return refuse("no_action", "Client is inactive; no autonomous work is performed.", [
      "client_inactive",
    ]);
  }

  if (context.duplicateOfOpenWork) {
    return refuse(
      "suppress_duplicate",
      "An open opportunity with the same fingerprint already exists; not duplicating it.",
      ["duplicate_open_work"],
    );
  }

  // A repeated job failure or budget pressure is ALWAYS worth surfacing, even
  // while actions are paused: those are the conditions under which the rest of
  // the bot's data becomes untrustworthy, and silence there is the failure mode.
  if (DIAGNOSTIC_ONLY.has(context.opportunityType)) {
    return {
      decision: "run_diagnostic",
      allowed: true,
      rationale:
        "Diagnostic opportunity: recorded for the operator without proposing a site change.",
      blockers: [],
    };
  }

  if (state.autonomousActionsPaused) {
    return refuse(
      "escalate_to_operator",
      `Autonomous actions are paused for this client${
        state.pauseReason ? `: ${state.pauseReason}` : ""
      }. Recorded for operator review.`,
      ["autonomous_actions_paused"],
    );
  }

  if (state.rankingCircuitOpen) {
    return refuse(
      "escalate_to_operator",
      "The ranking circuit breaker is open — rankings moved enough that further autonomous " +
        "change would confound attribution. Recorded for operator review.",
      ["ranking_circuit_open"],
    );
  }

  if (context.opportunityScore < context.minScore) {
    return refuse(
      "no_action",
      `Score ${context.opportunityScore} is below the ${context.minScore} action threshold; ` +
        "recorded and left for a later cycle.",
      ["below_score_threshold"],
    );
  }

  if (context.actionsTakenThisRun >= context.maxActionsPerRun) {
    return refuse(
      "defer_budget",
      `Per-run action ceiling (${context.maxActionsPerRun}) reached; deferred to the next cycle.`,
      ["max_actions_per_run"],
    );
  }

  // Unknown budget is treated as exhausted. Reasoning from "we do not know" to
  // "therefore proceed" is how a spend cap becomes a suggestion.
  if (context.requiresLlm) {
    if (state.dailyLlmBudgetRemaining === null) {
      blockers.push("llm_budget_unknown");
    } else if (state.dailyLlmBudgetRemaining <= 0) {
      blockers.push("llm_budget_exhausted");
    }
  }

  if (blockers.length > 0) {
    return refuse(
      "defer_budget",
      `Token budget unavailable (${blockers.join(", ")}); deferred rather than spent blind.`,
      blockers,
    );
  }

  if (context.isOutreach) {
    if (state.outreachCapacityRemaining === null) {
      return refuse(
        "defer_budget",
        "Outreach velocity capacity is unknown; deferring rather than risking a velocity spike.",
        ["outreach_capacity_unknown"],
      );
    }
    if (state.outreachCapacityRemaining <= 0) {
      return refuse(
        "defer_budget",
        "Outreach velocity governor has no capacity remaining for this client.",
        ["outreach_capacity_exhausted"],
      );
    }
  }

  return {
    decision: "propose_action",
    allowed: true,
    rationale:
      `Score ${context.opportunityScore} clears the ${context.minScore} threshold and no ` +
      "governor is engaged. Proposing through the execution policy, which decides autonomy " +
      "versus approval.",
    blockers: [],
  };
}

function refuse(
  decision: DecisionKind,
  rationale: string,
  blockers: readonly string[],
): PolicyVerdict {
  return { decision, allowed: false, rationale, blockers };
}

/**
 * Default state for a client with no policy row yet.
 *
 * Deliberately NOT fail-closed: an unconfigured client is a normal new client,
 * and pausing every new tenant until someone inserts a row would make the plane
 * useless. The governors that matter fail closed at the point of spending
 * (unknown budget defers above), which is where the actual risk is.
 */
export function defaultPolicyState(): PolicyState {
  return {
    autonomousActionsPaused: false,
    pauseReason: null,
    dailyLlmBudgetRemaining: null,
    outreachCapacityRemaining: null,
    rankingCircuitOpen: false,
  };
}
