/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

/**
 * GAP-001 — Critical-action approval boundary.
 *
 * The execution policy is the ONLY gate between an autonomous action and the
 * live site. `evaluateExecution` auto-executes low/medium/high and holds ONLY
 * `critical`. The pre-existing suite never exercised the real policy (the
 * plan-executor test mocks `evaluateExecution`), so a mutation that let a
 * `critical` action auto-execute — e.g. `if (riskLevel === 'critical') return
 * { execute: true }` — would ship green. These tests pin the boundary directly:
 * every risk level, the unknown-action fallback, each critical taxonomy entry,
 * and the persisted `pending_approval` status on denial.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB + logger stubs (logAction/approve/reject persist decisions) ─────────────
const insertReturningMock = vi.fn().mockResolvedValue([{ id: "action-uuid-1" }]);
const insertValuesMock = vi.fn((..._args: unknown[]) => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateWhereMock = vi.fn().mockResolvedValue([]);
const updateSetMock = vi.fn((..._args: unknown[]) => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: insertMock, update: updateMock }),
  // Column handles only need to be distinguishable objects for eq()/set().
  schema: {
    actionLog: {
      id: "actionLog.id",
      status: "actionLog.status",
      clientId: "actionLog.clientId",
      createdAt: "actionLog.createdAt",
    },
  },
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  type ActionProposal,
  approveAction,
  classifyAction,
  classifyActionForOrigin,
  createProposal,
  evaluateExecution,
  isComposedOrigin,
  logAction,
  type RiskLevel,
  rejectAction,
} from "../../src/core/execution-policy.js";

function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    clientId: "client-1",
    module: "serp-intelligence",
    action: "meta_title_update",
    description: "Update the meta title",
    rationale: "competitor overtook position #1",
    triggeredBy: "competitor:roofingpros.com",
    riskLevel: "low",
    reversible: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: "action-uuid-1" }]);
  updateWhereMock.mockResolvedValue([]);
});

describe("evaluateExecution — the approval boundary (GAP-001)", () => {
  it("NEVER auto-executes a critical action", () => {
    const decision = evaluateExecution(
      proposal({ riskLevel: "critical", action: "site_redesign" }),
    );
    expect(decision.execute).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain("CRITICAL");
  });

  it.each<RiskLevel>(["low", "medium", "high"])(
    "auto-executes a %s action without approval",
    (riskLevel) => {
      const decision = evaluateExecution(proposal({ riskLevel }));
      expect(decision.execute).toBe(true);
      expect(decision.requiresApproval).toBe(false);
    },
  );

  it("is the only gate: even irreversible high-risk still auto-executes", () => {
    // page_deletion is high + irreversible; policy still auto-executes (backups).
    const decision = evaluateExecution(
      proposal({ riskLevel: "high", reversible: false, action: "page_deletion" }),
    );
    expect(decision.execute).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });
});

describe("classifyAction — taxonomy + fallback (GAP-001)", () => {
  it.each([
    "site_redesign",
    "seo_strategy_overhaul",
    "domain_migration",
    "domain_change",
    "bulk_page_delete",
    "bulk_redirect_change",
    "hosting_migration",
  ])("keeps %s classified as critical (must never drift to auto-execute)", (action) => {
    const { riskLevel } = classifyAction(action);
    expect(riskLevel).toBe("critical");
    // And the boundary agrees: a critical classification is held for approval.
    expect(evaluateExecution(proposal({ riskLevel, action })).requiresApproval).toBe(true);
  });

  it("classifies representative low/medium/high actions per the authored taxonomy", () => {
    expect(classifyAction("meta_description_update")).toEqual({
      riskLevel: "low",
      reversible: true,
    });
    expect(classifyAction("content_rewrite")).toEqual({ riskLevel: "medium", reversible: true });
    expect(classifyAction("page_deletion")).toEqual({ riskLevel: "high", reversible: false });
    expect(classifyAction("citation_submission")).toEqual({ riskLevel: "low", reversible: false });
  });

  it("falls back to medium/reversible (auto-execute) for an unknown action", () => {
    const classification = classifyAction("totally_new_action_type");
    expect(classification).toEqual({ riskLevel: "medium", reversible: true });
    // The fallback must NOT be critical — an unknown action auto-executes.
    expect(
      evaluateExecution(proposal({ ...classification, action: "totally_new_action_type" })).execute,
    ).toBe(true);
  });

  it("createProposal stamps the classified risk/reversibility onto the proposal", () => {
    const p = createProposal({
      clientId: "c1",
      module: "links",
      action: "domain_migration",
      description: "move domains",
      rationale: "rebrand",
      triggeredBy: "operator",
    });
    expect(p.riskLevel).toBe("critical");
    expect(p.reversible).toBe(false);
  });
});

describe("logAction — options reach a jsonb column as JSON, not as a string", () => {
  it("passes the options array through rather than JSON.stringify-ing it", async () => {
    // REGRESSION. `action_log.options` is declared jsonb, so Drizzle serializes
    // the value itself. Stringifying first stored a JSON *string* inside a JSON
    // column — a read returned "[{\"id\":...}]" rather than an array, so every
    // consumer had to know to parse twice, and `options->>'id'` in SQL matched
    // nothing. Nothing caught it because no test asserted the written shape.
    const options = [
      {
        id: "opt-a",
        label: "Rewrite the intro",
        description: "Tighten the first paragraph",
        riskLevel: "low" as const,
        reversible: true,
        recommended: true,
        confidence: 0.8,
      },
    ];
    const p = createProposal({
      clientId: "c1",
      module: "serp-intelligence",
      action: "meta_title_update",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
      options,
    });
    await logAction(p, evaluateExecution(p));

    const written = insertValuesMock.mock.calls[0][0] as { options: unknown };
    expect(typeof written.options).not.toBe("string");
    expect(Array.isArray(written.options)).toBe(true);
    expect(written.options).toEqual(options);
  });

  it("writes null when a proposal carries no options", async () => {
    const p = createProposal({
      clientId: "c1",
      module: "serp-intelligence",
      action: "meta_title_update",
      description: "d",
      rationale: "r",
      triggeredBy: "test",
    });
    await logAction(p, evaluateExecution(p));
    expect((insertValuesMock.mock.calls[0][0] as { options: unknown }).options).toBeNull();
  });
});

describe("logAction — persisted status reflects the decision (GAP-001)", () => {
  it("persists pending_approval when execution is denied (critical)", async () => {
    const p = createProposal({
      clientId: "c1",
      module: "serp",
      action: "site_redesign",
      description: "redesign",
      rationale: "overhaul",
      triggeredBy: "operator",
    });
    const decision = evaluateExecution(p);
    const id = await logAction(p, decision);

    expect(id).toBe("action-uuid-1");
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      status: "pending_approval",
      riskLevel: "critical",
      action: "site_redesign",
    });
  });

  it("persists auto_executed when execution is allowed", async () => {
    const p = proposal({ riskLevel: "low", action: "meta_title_update" });
    await logAction(p, evaluateExecution(p));
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({ status: "auto_executed" });
  });
});

describe("approveAction / rejectAction — resolve a single action (GAP-001)", () => {
  it("approveAction sets status=approved for exactly the given id", async () => {
    await approveAction("action-uuid-1");
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock.mock.calls[0][0]).toMatchObject({ status: "approved" });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });

  it("rejectAction sets status=rejected for exactly the given id", async () => {
    await rejectAction("action-uuid-1");
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock.mock.calls[0][0]).toMatchObject({ status: "rejected" });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Origin-aware fail-closed classification (hardening contract C5) ──────────

describe("classifyActionForOrigin — unknown composed actions fail closed", () => {
  it("still returns the table's classification for a known action, whatever the origin", () => {
    // The gate must not re-risk actions that ARE classified; it only decides what
    // an unknown one becomes.
    const known = classifyAction("meta_title_update");
    expect(classifyActionForOrigin("intelligence:x:y", "meta_title_update")).toEqual(known);
    expect(classifyActionForOrigin("cron:weekly", "meta_title_update")).toEqual(known);
  });

  it("makes an UNKNOWN action from the intelligence plane critical and irreversible", () => {
    // Without this the unknown-action default is medium/reversible, which is the
    // band that auto-executes — so a composed action nobody classified would run
    // itself. Critical routes it to the approval queue instead.
    expect(classifyActionForOrigin("intelligence:aeo_gap:abc123", "invented_action")).toEqual({
      riskLevel: "critical",
      reversible: false,
    });
  });

  it("leaves hand-written callers on the permissive default", () => {
    // The default is correct for module jobs, where an unclassified action is a
    // typo caught in review rather than a runtime gap. Narrowing it everywhere
    // would turn every such typo into a stuck approval queue.
    expect(classifyActionForOrigin("cron:serp-daily", "invented_action")).toEqual({
      riskLevel: "medium",
      reversible: true,
    });
  });

  it("routes an unknown composed action to approval, end to end", () => {
    const composed = createProposal({
      clientId: "c1",
      module: "web-vitals",
      action: "invented_action",
      description: "d",
      rationale: "r",
      triggeredBy: "intelligence:page_slow:fp1",
    });
    expect(composed.riskLevel).toBe("critical");
    expect(evaluateExecution(composed).execute).toBe(false);
    expect(evaluateExecution(composed).requiresApproval).toBe(true);
  });

  it("recognises the plane by triggeredBy, NOT by module", () => {
    // The load-bearing detail. An intelligence-plane proposal carries the module
    // that will EXECUTE it, so `module === "intelligence"` matches nothing: a
    // module-keyed gate would be dead code that looks like a control.
    expect(isComposedOrigin("intelligence:page_slow:fp1")).toBe(true);
    expect(isComposedOrigin("cron:web-vitals")).toBe(false);

    const viaModuleName = createProposal({
      clientId: "c1",
      // The real module on every intelligence proposal — never "intelligence".
      module: "web-vitals",
      action: "invented_action",
      description: "d",
      rationale: "r",
      triggeredBy: "cron:web-vitals",
    });
    // Same module, non-composed origin: the permissive default still applies,
    // which is what proves the discriminator is the origin and not the module.
    expect(viaModuleName.riskLevel).toBe("medium");
  });
});
