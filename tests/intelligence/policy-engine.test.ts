/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The policy engine is the gate between autonomous reasoning and any mutation.
 * It can only ever REFUSE — a `propose_action` verdict just means "continue to
 * the execution policy" — so the tests that matter are the refusals, and the
 * ordering that decides which reason the operator is told.
 *
 * The unknown-budget case is the sharpest one: reasoning from "we do not know
 * what is left" to "therefore spend" is how a cap becomes a suggestion.
 */

import { describe, expect, it } from "vitest";
import {
  defaultPolicyState,
  evaluatePolicy,
  type PolicyContext,
  type PolicyState,
} from "../../src/intelligence/policy-engine.js";

function state(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    autonomousActionsPaused: false,
    pauseReason: null,
    dailyLlmBudgetRemaining: 5,
    outreachCapacityRemaining: 3,
    rankingCircuitOpen: false,
    ...overrides,
  };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    clientActive: true,
    opportunityType: "keyword_recovery",
    opportunityScore: 50,
    minScore: 20,
    requiresLlm: false,
    isOutreach: false,
    duplicateOfOpenWork: false,
    actionsTakenThisRun: 0,
    maxActionsPerRun: 3,
    ...overrides,
  };
}

describe("evaluatePolicy — allowing", () => {
  it("proposes when nothing is engaged and the score clears the bar", () => {
    const verdict = evaluatePolicy(state(), context());
    expect(verdict.decision).toBe("propose_action");
    expect(verdict.allowed).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("says explicitly that proposing is not executing", () => {
    const verdict = evaluatePolicy(state(), context());
    expect(verdict.rationale).toMatch(/execution policy/i);
  });
});

describe("evaluatePolicy — refusals, in precedence order", () => {
  it("puts an inactive client above every other reason", () => {
    const verdict = evaluatePolicy(
      state({ autonomousActionsPaused: true, rankingCircuitOpen: true }),
      context({ clientActive: false, opportunityScore: 0 }),
    );
    expect(verdict.decision).toBe("no_action");
    expect(verdict.blockers).toEqual(["client_inactive"]);
  });

  it("suppresses an opportunity already open under the same fingerprint", () => {
    const verdict = evaluatePolicy(state(), context({ duplicateOfOpenWork: true }));
    expect(verdict.decision).toBe("suppress_duplicate");
    expect(verdict.allowed).toBe(false);
  });

  it("escalates rather than acting while the operator has paused the client", () => {
    const verdict = evaluatePolicy(
      state({ autonomousActionsPaused: true, pauseReason: "migration in progress" }),
      context(),
    );
    expect(verdict.decision).toBe("escalate_to_operator");
    expect(verdict.allowed).toBe(false);
    expect(verdict.rationale).toContain("migration in progress");
  });

  it("escalates while the ranking circuit breaker is open", () => {
    const verdict = evaluatePolicy(state({ rankingCircuitOpen: true }), context());
    expect(verdict.decision).toBe("escalate_to_operator");
    expect(verdict.blockers).toEqual(["ranking_circuit_open"]);
  });

  it("takes no action below the score threshold", () => {
    const verdict = evaluatePolicy(state(), context({ opportunityScore: 19, minScore: 20 }));
    expect(verdict.decision).toBe("no_action");
    expect(verdict.blockers).toEqual(["below_score_threshold"]);
  });

  it("treats the threshold as inclusive", () => {
    const verdict = evaluatePolicy(state(), context({ opportunityScore: 20, minScore: 20 }));
    expect(verdict.decision).toBe("propose_action");
  });

  it("defers once the per-run action ceiling is reached", () => {
    const verdict = evaluatePolicy(
      state(),
      context({ actionsTakenThisRun: 3, maxActionsPerRun: 3 }),
    );
    expect(verdict.decision).toBe("defer_budget");
    expect(verdict.blockers).toEqual(["max_actions_per_run"]);
  });

  it("honours a zero action ceiling as a full stop on proposals", () => {
    const verdict = evaluatePolicy(
      state(),
      context({ actionsTakenThisRun: 0, maxActionsPerRun: 0 }),
    );
    expect(verdict.decision).toBe("defer_budget");
  });
});

describe("evaluatePolicy — budget is fail-closed", () => {
  it("defers a token-spending action when the remaining budget is UNKNOWN", () => {
    const verdict = evaluatePolicy(
      state({ dailyLlmBudgetRemaining: null }),
      context({ requiresLlm: true }),
    );
    expect(verdict.decision).toBe("defer_budget");
    expect(verdict.blockers).toEqual(["llm_budget_unknown"]);
  });

  it("defers a token-spending action when the budget is exhausted", () => {
    const verdict = evaluatePolicy(
      state({ dailyLlmBudgetRemaining: 0 }),
      context({ requiresLlm: true }),
    );
    expect(verdict.blockers).toEqual(["llm_budget_exhausted"]);
  });

  it("does NOT block a zero-token action on an unknown token budget", () => {
    // A page-speed fix spends nothing; blocking it on an LLM budget would make
    // the plane useless exactly when spend is tight.
    const verdict = evaluatePolicy(
      state({ dailyLlmBudgetRemaining: null }),
      context({ requiresLlm: false }),
    );
    expect(verdict.decision).toBe("propose_action");
  });

  it("defers outreach when velocity capacity is unknown or spent", () => {
    for (const remaining of [null, 0]) {
      const verdict = evaluatePolicy(
        state({ outreachCapacityRemaining: remaining }),
        context({ isOutreach: true }),
      );
      expect(verdict.decision, String(remaining)).toBe("defer_budget");
    }
  });

  it("allows outreach while velocity headroom remains", () => {
    const verdict = evaluatePolicy(
      state({ outreachCapacityRemaining: 1 }),
      context({ isOutreach: true }),
    );
    expect(verdict.decision).toBe("propose_action");
  });

  it("does not apply the outreach governor to non-outreach work", () => {
    const verdict = evaluatePolicy(
      state({ outreachCapacityRemaining: 0 }),
      context({ isOutreach: false }),
    );
    expect(verdict.decision).toBe("propose_action");
  });
});

describe("evaluatePolicy — diagnostics are never silenced", () => {
  it("still surfaces repeated job failures while actions are paused", () => {
    // If the pipeline is broken, every other signal for this client is suspect.
    // Going quiet about that because actions are paused is the worst outcome.
    const verdict = evaluatePolicy(
      state({ autonomousActionsPaused: true, rankingCircuitOpen: true }),
      context({ opportunityType: "pipeline_repair", opportunityScore: 1, minScore: 90 }),
    );
    expect(verdict.decision).toBe("run_diagnostic");
    expect(verdict.allowed).toBe(true);
  });

  it("still surfaces budget pressure while actions are paused", () => {
    const verdict = evaluatePolicy(
      state({ autonomousActionsPaused: true }),
      context({ opportunityType: "budget_review", opportunityScore: 1, minScore: 90 }),
    );
    expect(verdict.decision).toBe("run_diagnostic");
  });

  it("does not surface diagnostics for an inactive client", () => {
    const verdict = evaluatePolicy(
      state(),
      context({ opportunityType: "pipeline_repair", clientActive: false }),
    );
    expect(verdict.decision).toBe("no_action");
  });

  it("does not let a diagnostic bypass duplicate suppression", () => {
    const verdict = evaluatePolicy(
      state(),
      context({ opportunityType: "pipeline_repair", duplicateOfOpenWork: true }),
    );
    expect(verdict.decision).toBe("suppress_duplicate");
  });
});

describe("defaultPolicyState", () => {
  it("is permissive for structure but unknown for spend", () => {
    // A brand new client should not be paused; but nothing is known about its
    // budget, so any token-spending action still defers until a refresh runs.
    const fresh = defaultPolicyState();
    expect(fresh.autonomousActionsPaused).toBe(false);
    expect(fresh.rankingCircuitOpen).toBe(false);
    expect(fresh.dailyLlmBudgetRemaining).toBeNull();

    expect(evaluatePolicy(fresh, context({ requiresLlm: true })).decision).toBe("defer_budget");
    expect(evaluatePolicy(fresh, context({ requiresLlm: false })).decision).toBe("propose_action");
  });
});
