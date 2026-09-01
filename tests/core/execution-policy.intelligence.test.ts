/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

/**
 * The fail-closed boundary for LLM-selected actions.
 *
 * `classifyAction` deliberately fails OPEN: an unrecognised action from a
 * hand-written handler defaults to medium/auto-execute, which is the repo's
 * documented max-autonomy bet (pinned by execution-policy.test.ts).
 *
 * Intelligence actions are chosen by a model, so the same default would mean an
 * invented action string auto-executes. These tests pin the inverse rule for
 * that module, and — just as importantly — pin that the legacy behaviour is
 * unchanged for every other module, so the hardening cannot be mistaken for a
 * blanket policy change.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertReturningMock = vi.fn().mockResolvedValue([{ id: "action-uuid-1" }]);
const insertValuesMock = vi.fn((..._args: unknown[]) => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { actionLog: { id: "actionLog.id" } },
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  classifyAction,
  classifyIntelligenceAction,
  createProposal,
  evaluateExecution,
  INTELLIGENCE_ACTIONS,
  logAction,
} from "../../src/core/execution-policy.js";

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: "action-uuid-1" }]);
});

describe("intelligence actions fail closed", () => {
  it("fails closed for unknown intelligence actions", () => {
    const proposal = createProposal({
      clientId: "client-1",
      module: "intelligence",
      action: "llm_invented_delete_everything",
      description: "bad",
      rationale: "bad",
      triggeredBy: "test",
    });

    expect(proposal.riskLevel).toBe("critical");
    expect(proposal.reversible).toBe(false);

    const decision = evaluateExecution(proposal);
    expect(decision.execute).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it("rejects an action borrowed from another module's taxonomy", () => {
    // `meta_title_update` is a perfectly valid LOW-risk action for the SERP
    // module. Inside intelligence it is still outside the vocabulary, so it
    // must not inherit that module's classification — otherwise a planner
    // could reach any action any module has ever defined.
    expect(classifyAction("meta_title_update").riskLevel).toBe("low");

    const proposal = createProposal({
      clientId: "client-1",
      module: "intelligence",
      action: "meta_title_update",
      description: "borrowed",
      rationale: "borrowed",
      triggeredBy: "test",
    });
    expect(proposal.riskLevel).toBe("critical");
  });

  it.each([
    ["intelligence_signal_only", "low"],
    ["intelligence_generate_recommendation", "low"],
    ["intelligence_run_competitor_analysis", "low"],
    ["intelligence_optimize_faq_draft", "low"],
    ["intelligence_generate_surpass_plan", "medium"],
    ["intelligence_request_site_fix", "medium"],
    ["intelligence_queue_outreach", "high"],
    ["intelligence_execute_site_change", "critical"],
  ])("classifies %s as %s", (action, expected) => {
    expect(classifyIntelligenceAction(action).riskLevel).toBe(expected);
  });

  it("always holds intelligence_execute_site_change for approval", () => {
    const proposal = createProposal({
      clientId: "client-1",
      module: "intelligence",
      action: "intelligence_execute_site_change",
      description: "mutate",
      rationale: "mutate",
      triggeredBy: "test",
    });
    expect(evaluateExecution(proposal).requiresApproval).toBe(true);
  });

  it("marks outreach irreversible so it is never treated as rollback-safe", () => {
    expect(classifyIntelligenceAction("intelligence_queue_outreach").reversible).toBe(false);
  });

  it("exposes the vocabulary as a closed allow-list", () => {
    expect(INTELLIGENCE_ACTIONS).toContain("intelligence_signal_only");
    expect(INTELLIGENCE_ACTIONS).not.toContain("meta_title_update");
    // Every entry must be intelligence-namespaced: the planner's allow-list is
    // derived from this array, so a stray entry would widen what a model can ask for.
    for (const action of INTELLIGENCE_ACTIONS) {
      expect(action.startsWith("intelligence_")).toBe(true);
    }
  });

  it("persists an unknown intelligence action as pending_approval, not auto_executed", async () => {
    const proposal = createProposal({
      clientId: "client-1",
      module: "intelligence",
      action: "llm_invented_action",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    await logAction(proposal, evaluateExecution(proposal));

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      status: "pending_approval",
      riskLevel: "critical",
      module: "intelligence",
    });
  });
});

describe("non-intelligence modules keep the legacy fail-open default", () => {
  it("still auto-executes an unknown action from a hand-written handler", () => {
    const proposal = createProposal({
      clientId: "client-1",
      module: "serp-intelligence",
      action: "totally_new_action_type",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    expect(proposal.riskLevel).toBe("medium");
    expect(evaluateExecution(proposal).execute).toBe(true);
  });

  it("does not treat a module merely containing the word as intelligence", () => {
    // `build-intelligence` is a different, pre-existing module. Matching on a
    // substring rather than equality would silently re-classify its actions.
    const proposal = createProposal({
      clientId: "client-1",
      module: "build-intelligence",
      action: "totally_new_action_type",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    expect(proposal.riskLevel).toBe("medium");
  });
});
