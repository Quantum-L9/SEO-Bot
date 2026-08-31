/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

/**
 * INTEL-GATE-001 — the fail-closed boundary for intelligence actions.
 *
 * This is the hard red test from the acceptance brief, and the single most
 * consequential assertion in the intelligence work.
 *
 * The general execution policy runs at maximum autonomy: low, medium, and high
 * all auto-execute, and an UNKNOWN action falls back to medium — i.e. it
 * auto-executes. That fallback is defensible for the producer modules, whose
 * action strings are authored in code. It is indefensible for the intelligence
 * loop, whose action strings can originate from a language model: under the
 * general fallback, a planner that emitted `llm_invented_delete_everything`
 * would have had it classified medium/reversible and auto-executed.
 *
 * So intelligence proposals are classified against a CLOSED vocabulary and
 * anything outside it is critical. These tests pin both halves — the closed
 * vocabulary and the fail-closed fallback — and pin that the general fallback
 * was NOT changed, because widening the fail-closed rule to every module would
 * silently convert existing auto-executing actions into approval queue entries.
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
  createProposal,
  evaluateExecution,
  INTELLIGENCE_ACTIONS,
  logAction,
} from "../../src/core/execution-policy.js";

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: "action-uuid-1" }]);
});

describe("unknown intelligence actions fail closed", () => {
  it("fails closed for unknown intelligence actions", () => {
    const proposal = createProposal({
      clientId: "client-a",
      module: "intelligence",
      action: "llm_invented_delete_everything",
      description: "bad",
      rationale: "bad",
      triggeredBy: "test",
    });

    expect(proposal.riskLevel).toBe("critical");

    const decision = evaluateExecution(proposal);
    expect(decision.execute).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it.each([
    // An empty string, a near-miss on a real action, and a plausible-looking
    // name are all equally unknown. None may auto-execute.
    "",
    "intelligence_",
    "intelligence_execute_site_changes",
    "INTELLIGENCE_SIGNAL_ONLY",
    "intelligence_drop_all_tables",
    "../../etc/passwd",
  ])("holds %j for approval rather than auto-executing", (action) => {
    const proposal = createProposal({
      clientId: "client-a",
      module: "intelligence",
      action,
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    expect(proposal.riskLevel).toBe("critical");
    expect(evaluateExecution(proposal).execute).toBe(false);
  });

  it("refuses a general-taxonomy action name proposed BY intelligence", () => {
    // `page_deletion` is a real, high-risk action — but it belongs to the
    // producer modules. The intelligence loop routes work to those modules; it
    // does not name their actions directly. A planner reaching for one is
    // reaching outside its vocabulary, so it fails closed like any other
    // unknown string, even though the name exists elsewhere.
    const proposal = createProposal({
      clientId: "client-a",
      module: "intelligence",
      action: "page_deletion",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    expect(proposal.riskLevel).toBe("critical");
    expect(evaluateExecution(proposal).requiresApproval).toBe(true);
  });

  it("persists the refusal as pending_approval rather than auto_executed", async () => {
    const proposal = createProposal({
      clientId: "client-a",
      module: "intelligence",
      action: "llm_invented_delete_everything",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    await logAction(proposal, evaluateExecution(proposal));

    const persisted = insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(persisted.status).toBe("pending_approval");
    expect(persisted.module).toBe("intelligence");
    expect(persisted.riskLevel).toBe("critical");
  });
});

describe("the known intelligence vocabulary", () => {
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
    expect(classifyAction(action, "intelligence").riskLevel).toBe(expected);
  });

  it("always holds intelligence_execute_site_change for approval", () => {
    const proposal = createProposal({
      clientId: "client-a",
      module: "intelligence",
      action: "intelligence_execute_site_change",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    expect(evaluateExecution(proposal).execute).toBe(false);
    expect(evaluateExecution(proposal).requiresApproval).toBe(true);
  });

  it("marks the two irreversible actions as irreversible", () => {
    expect(classifyAction("intelligence_queue_outreach", "intelligence").reversible).toBe(false);
    expect(classifyAction("intelligence_execute_site_change", "intelligence").reversible).toBe(
      false,
    );
  });

  it("exports exactly the vocabulary the planner validates against", () => {
    expect([...INTELLIGENCE_ACTIONS].sort()).toEqual(
      [
        "intelligence_execute_site_change",
        "intelligence_generate_recommendation",
        "intelligence_generate_surpass_plan",
        "intelligence_optimize_faq_draft",
        "intelligence_queue_outreach",
        "intelligence_request_site_fix",
        "intelligence_run_competitor_analysis",
        "intelligence_signal_only",
      ].sort(),
    );
  });
});

describe("the general fallback is unchanged", () => {
  it("still classifies an unknown NON-intelligence action as medium/auto-execute", () => {
    // Guards the blast radius of the fail-closed change. Had it been applied
    // globally, every producer module's unrecognised action would start
    // queueing for approval — a silent behavioural change to five modules
    // that nobody asked for.
    expect(classifyAction("totally_new_action_type")).toEqual({
      riskLevel: "medium",
      reversible: true,
    });
    expect(classifyAction("totally_new_action_type", "link-building")).toEqual({
      riskLevel: "medium",
      reversible: true,
    });
  });

  it("classifies a KNOWN intelligence action name normally when another module proposes it", () => {
    // The closed vocabulary is scoped to the intelligence module, not to the
    // string. Another module naming an intelligence action gets the general
    // taxonomy's answer — unknown there, hence medium.
    expect(classifyAction("intelligence_signal_only", "serp-intelligence")).toEqual({
      riskLevel: "medium",
      reversible: true,
    });
  });
});
