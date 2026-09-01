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
  capabilitiesForMode,
  type IntelligenceMode,
  resolveCapabilities,
} from "../../../src/modules/intelligence/modes.js";
import {
  evaluateIntelligenceAction,
  type PolicyGateInput,
  requireClientId,
} from "../../../src/modules/intelligence/policy-gate.js";

const CLIENT = { id: "client-a", active: true };

const ALL_FLAGS_ON = {
  llmPlanningEnabled: true,
  allowSafeJobRouting: true,
  allowOutreachRouting: true,
  allowSiteMutation: true,
};

function input(overrides: Partial<PolicyGateInput> = {}): PolicyGateInput {
  const mode: IntelligenceMode = overrides.mode ?? "full";
  return {
    clientId: "client-a",
    action: "intelligence_run_competitor_analysis",
    mode,
    capabilities: resolveCapabilities(mode, ALL_FLAGS_ON),
    client: CLIENT,
    llmBudgetExhausted: false,
    rankingCircuitBreakerOpen: false,
    outreachVelocityExhausted: false,
    siteDeploymentReady: true,
    siteDeployDryRun: false,
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
  it("blocks when mode is off", () => {
    const decision = evaluateIntelligenceAction(
      input({ mode: "off", capabilities: capabilitiesForMode("off") }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/INTELLIGENCE_MODE=off/);
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

  it("blocks LLM planning when the mode/flag does not permit it", () => {
    const decision = evaluateIntelligenceAction(
      input({
        mode: "route_safe",
        capabilities: resolveCapabilities("route_safe", ALL_FLAGS_ON),
        requiresLlm: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/LLM planning not permitted/);
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

  it("blocks safe job routing when the flag is off", () => {
    const decision = evaluateIntelligenceAction(
      input({
        capabilities: resolveCapabilities("full", { ...ALL_FLAGS_ON, allowSafeJobRouting: false }),
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/safe job routing not permitted/);
  });

  it("blocks outreach in route_safe even with the outreach flag on", () => {
    const decision = evaluateIntelligenceAction(
      input({
        mode: "route_safe",
        capabilities: resolveCapabilities("route_safe", ALL_FLAGS_ON),
        action: "intelligence_queue_outreach",
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/outreach routing not permitted/);
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

  it("blocks an unknown action even in full mode with every flag on", () => {
    const decision = evaluateIntelligenceAction(
      input({
        action: "definitely_not_real",
        mode: "full",
        capabilities: resolveCapabilities("full", ALL_FLAGS_ON),
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("never auto-allows a critical action, whatever the mode", () => {
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
        mode: "off",
        capabilities: capabilitiesForMode("off"),
        client: { id: "client-a", active: false },
        action: "intelligence_queue_outreach",
        outreachVelocityExhausted: true,
        rankingCircuitBreakerOpen: true,
      }),
    );
    expect(decision.allowed).toBe(false);
    const joined = decision.reasons.join(" | ");
    expect(joined).toMatch(/INTELLIGENCE_MODE=off/);
    expect(joined).toMatch(/inactive/);
    expect(joined).toMatch(/outreach routing not permitted/);
    expect(joined).toMatch(/velocity allowance exhausted/);
    expect(joined).toMatch(/circuit breaker/);
    expect(decision.reasons.length).toBeGreaterThanOrEqual(5);
  });
});
