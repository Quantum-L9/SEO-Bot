/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * The policy gate is the single choke point between a decision and an effect.
 *
 * Beyond checking each rule, these tests pin two structural properties:
 *
 *  - IT COLLECTS ALL REASONS. An operator debugging a blocked action needs every
 *    cause, not whichever check happened to run first. A short-circuiting gate
 *    sends people to fix one flag, redeploy, and hit the next block.
 *  - IT DENIES BY DEFAULT. An action type with no matching rule falls through to
 *    the safe-job branch and is denied unless routing is on — so adding an action
 *    without adding a gate rule fails closed.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  type IntelligenceCapabilities,
  resolveCapabilities,
} from "../../../src/modules/intelligence/capabilities.js";
import {
  evaluateIntelligenceAction,
  type PolicyGateInput,
  requireClientId,
} from "../../../src/modules/intelligence/policy-gate.js";

const CLIENT = { id: "client-a", active: true };

function caps(overrides: Record<string, unknown> = {}): IntelligenceCapabilities {
  return resolveCapabilities({
    INTELLIGENCE_ENABLED: true,
    INTELLIGENCE_LLM_PLANNING_ENABLED: true,
    INTELLIGENCE_AUTO_ROUTE_LOW_RISK: true,
    INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED: false,
    INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT: 10,
    INTELLIGENCE_MIN_SCORE_TO_PLAN: 50,
    INTELLIGENCE_SIGNAL_STALE_DAYS: 14,
    ...overrides,
  } as never);
}

function input(overrides: Partial<PolicyGateInput> = {}): PolicyGateInput {
  return {
    clientId: "client-a",
    action: "intelligence_run_competitor_analysis",
    capabilities: caps(),
    client: CLIENT,
    score: 80,
    llmBudgetExhausted: false,
    rankingCircuitBreakerOpen: false,
    outreachVelocityExhausted: false,
    siteDeploymentReady: true,
    siteDeployDryRun: false,
    duplicateActionPending: false,
    measurementWindowActive: false,
    requiresLlm: false,
    ...overrides,
  };
}

describe("clientId is a precondition, not a policy outcome", () => {
  it("throws on a missing clientId rather than returning blocked", () => {
    // Returning {allowed:false} would log a routine block while an unscoped,
    // cross-tenant query is about to run upstream.
    expect(() => evaluateIntelligenceAction(input({ clientId: undefined }))).toThrow(/clientId/);
    expect(() => evaluateIntelligenceAction(input({ clientId: "  " }))).toThrow(/clientId/);
  });

  it("requireClientId returns the id when valid", () => {
    expect(requireClientId("client-a")).toBe("client-a");
  });
});

describe("baseline", () => {
  it("allows a safe analysis action in full mode with everything enabled", () => {
    const decision = evaluateIntelligenceAction(input());
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
  });
});

describe("each gate blocks", () => {
  it("blocks when the module is disabled", () => {
    const decision = evaluateIntelligenceAction(
      input({ capabilities: caps({ INTELLIGENCE_ENABLED: false }) }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/INTELLIGENCE_ENABLED=false/);
  });

  it("blocks an opportunity scoring below the plan threshold", () => {
    const decision = evaluateIntelligenceAction(input({ score: 41 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/below INTELLIGENCE_MIN_SCORE_TO_PLAN/);
  });

  it("blocks a duplicate action already pending for the opportunity", () => {
    const decision = evaluateIntelligenceAction(input({ duplicateActionPending: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/already pending/);
  });

  it("blocks while a measurement window is open", () => {
    // Acting again mid-window destroys the attribution: the second action's
    // effect is indistinguishable from the first's.
    const decision = evaluateIntelligenceAction(input({ measurementWindowActive: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/measurement window/);
  });

  it("blocks when the client is inactive", () => {
    const decision = evaluateIntelligenceAction(
      input({ client: { id: "client-a", active: false } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/inactive/);
  });

  it("blocks when the client is not found", () => {
    const decision = evaluateIntelligenceAction(input({ client: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/not found/);
  });

  it("blocks LLM planning when the daily budget is exhausted", () => {
    const decision = evaluateIntelligenceAction(
      input({ requiresLlm: true, llmBudgetExhausted: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/daily spend cap/);
  });

  it("blocks LLM planning when its flag is off", () => {
    const decision = evaluateIntelligenceAction(
      input({
        capabilities: caps({ INTELLIGENCE_LLM_PLANNING_ENABLED: false }),
        requiresLlm: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/INTELLIGENCE_LLM_PLANNING_ENABLED=false/);
  });

  it("blocks outreach when the velocity allowance is spent", () => {
    const decision = evaluateIntelligenceAction(
      input({ action: "intelligence_queue_outreach", outreachVelocityExhausted: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/velocity allowance exhausted/);
  });

  it("blocks outreach and site changes when the ranking circuit breaker is open", () => {
    const outreach = evaluateIntelligenceAction(
      input({ action: "intelligence_queue_outreach", rankingCircuitBreakerOpen: true }),
    );
    expect(outreach.reasons.join(" ")).toMatch(/circuit breaker/);

    const mutation = evaluateIntelligenceAction(
      input({ action: "intelligence_execute_site_change", rankingCircuitBreakerOpen: true }),
    );
    expect(mutation.reasons.join(" ")).toMatch(/circuit breaker/);
  });

  it("blocks site mutation when site_deployment is not ready", () => {
    const decision = evaluateIntelligenceAction(
      input({ action: "intelligence_execute_site_change", siteDeploymentReady: false }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/site_deployment config is not ready/);
  });

  it("blocks live mutation while SITE_DEPLOY_DRY_RUN is active", () => {
    const decision = evaluateIntelligenceAction(
      input({ action: "intelligence_execute_site_change", siteDeployDryRun: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/SITE_DEPLOY_DRY_RUN/);
  });

  it("blocks analysis routing when auto-route is off", () => {
    const decision = evaluateIntelligenceAction(
      input({ capabilities: caps({ INTELLIGENCE_AUTO_ROUTE_LOW_RISK: false }) }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/INTELLIGENCE_AUTO_ROUTE_LOW_RISK=false/);
  });

  it("still permits a proposal-only action when auto-route is off", () => {
    // Recording a recommendation causes nothing downstream, so the routing flag
    // must not suppress it — otherwise turning routing off would also blind the
    // operator to what the loop noticed.
    const decision = evaluateIntelligenceAction(
      input({
        action: "intelligence_generate_recommendation",
        capabilities: caps({ INTELLIGENCE_AUTO_ROUTE_LOW_RISK: false }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("unknown actions fail closed", () => {
  it("blocks and marks an unknown action critical / approval-required", () => {
    const decision = evaluateIntelligenceAction(input({ action: "llm_invented_action" }));
    expect(decision.allowed).toBe(false);
    expect(decision.riskLevel).toBe("critical");
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reasons.join(" ")).toMatch(/not in the intelligence vocabulary/);
  });

  it("blocks an unknown action even with every flag on", () => {
    const decision = evaluateIntelligenceAction(input({ action: "definitely_not_real" }));
    expect(decision.allowed).toBe(false);
  });

  it("never auto-allows a critical action, whatever the config", () => {
    const decision = evaluateIntelligenceAction(
      input({ action: "intelligence_execute_site_change", siteDeployDryRun: false }),
    );
    expect(decision.requiresApproval).toBe(true);
    expect(decision.allowed).toBe(false);
  });
});

describe("all reasons are collected, not just the first", () => {
  it("reports every failing rule at once", () => {
    const decision = evaluateIntelligenceAction(
      input({
        capabilities: caps({ INTELLIGENCE_ENABLED: false }),
        client: { id: "client-a", active: false },
        action: "intelligence_queue_outreach",
        score: 10,
        outreachVelocityExhausted: true,
        rankingCircuitBreakerOpen: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    const joined = decision.reasons.join(" | ");
    expect(joined).toMatch(/INTELLIGENCE_ENABLED=false/);
    expect(joined).toMatch(/inactive/);
    expect(joined).toMatch(/below INTELLIGENCE_MIN_SCORE_TO_PLAN/);
    expect(joined).toMatch(/velocity allowance exhausted/);
    expect(joined).toMatch(/circuit breaker/);
    expect(decision.reasons.length).toBeGreaterThanOrEqual(5);
  });
});
