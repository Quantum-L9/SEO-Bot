/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * This is the boundary the whole of C2 rests on: a model may RANK actions the
 * evidence pack already permits, and may not author one.
 *
 * The distinction is not stylistic. Every action in a pack's `allowed_actions`
 * is a key in the execution policy's taxonomy, so choosing among them cannot
 * change a proposal's risk band. An invented action would fall through
 * `classifyAction`'s unknown-action default to medium/reversible and silently
 * acquire auto-execute rights — a model talking its way past the approval gate
 * by naming something the taxonomy has never heard of.
 *
 * The second thing pinned here is graceful degradation. A model being
 * unavailable, over budget, or wrong must leave the deterministic template's
 * proposal exactly as it was: availability of a model is not allowed to become a
 * dependency of the bot reasoning at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

const tables = vi.hoisted(() => ({
  actionLog: {
    __table: "action_log",
    id: "action_log.id",
    clientId: "action_log.client_id",
    status: "action_log.status",
    options: "action_log.options",
    executedAt: "action_log.executed_at",
  },
  intelligenceDecisions: {
    __table: "decisions",
    id: "decisions.id",
    actionLogId: "decisions.action_log_id",
    evidenceSummary: "decisions.evidence_summary",
    policyBasis: "decisions.policy_basis",
  },
}));

const db = vi.hoisted(() => ({
  updates: [] as { table: string; values: unknown }[],
  selectQueue: [] as unknown[],
}));

const llm = vi.hoisted(() => ({
  calls: [] as { operation: string; args: Record<string, unknown> }[],
  /** Raw value the "model" returns, handed to the caller's own validator. */
  response: null as unknown,
  throws: null as Error | null,
}));

vi.mock("../../src/core/database/index.js", () => {
  const thenable = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const method of ["from", "where", "limit", "innerJoin", "leftJoin"]) p[method] = () => p;
    return p;
  };
  const instance = {
    select: () => thenable(db.selectQueue.shift() ?? []),
    update: (table: { __table: string }) => ({
      set: (values: unknown) => ({
        where: () => {
          db.updates.push({ table: table.__table, values });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { getDb: () => instance, schema: tables };
});

vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({
    // Mirrors the real executePolicyJson closely enough to matter: it runs the
    // CALLER's validator on the raw response, which is where rejection happens.
    executePolicyJson: async (
      operation: string,
      args: { validate: (value: unknown) => unknown } & Record<string, unknown>,
    ) => {
      llm.calls.push({ operation, args });
      if (llm.throws) throw llm.throws;
      return args.validate(llm.response);
    },
  }),
}));

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ INTELLIGENCE_LLM_PLANNING_ENABLED: config.enabled }),
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const config = vi.hoisted(() => ({ enabled: true }));

import type { EvidencePack } from "../../src/intelligence/evidence-pack.js";
import {
  ActionOutsideAllowListError,
  MAX_RANKED_ACTIONS,
  selectionToOptions,
  synthesizeActionSelection,
  synthesizePendingProposals,
  validateSelection,
} from "../../src/intelligence/plan-synthesizer.js";

function pack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    client: { industry: "legal", market: "NC" },
    opportunity: {
      type: "page_experience_repair",
      target_path: "/personal-injury",
      target_keyword: null,
      score: 42.5,
      urgency: 0.75,
      confidence: 0.8,
    },
    evidence: { exit_rate: 0.71, lcp: 3800 },
    allowed_actions: ["page_speed_optimization", "css_performance_fix", "heading_optimization"],
    forbidden_actions: ["site_redesign", "domain_migration"],
    ...overrides,
  };
}

const GOOD_RESPONSE = {
  summary: "A 71% exit rate on a page taking 3.8s to paint is a speed problem.",
  ranked: [
    {
      action: "page_speed_optimization",
      rationale: "LCP is 3800ms against a 2500ms threshold.",
      confidence: 0.82,
    },
    {
      action: "css_performance_fix",
      rationale: "Render-blocking CSS is the usual cause.",
      confidence: 0.5,
    },
  ],
};

beforeEach(() => {
  db.updates = [];
  db.selectQueue = [];
  llm.calls = [];
  llm.response = GOOD_RESPONSE;
  llm.throws = null;
  config.enabled = true;
});

// ─── The allow-list boundary ─────────────────────────────────────────────────

describe("validateSelection", () => {
  it("accepts a ranking drawn from the pack's own allow-list", () => {
    const selection = validateSelection(GOOD_RESPONSE, pack());
    expect(selection.ranked.map((entry) => entry.action)).toEqual([
      "page_speed_optimization",
      "css_performance_fix",
    ]);
  });

  it("REJECTS an action the pack did not offer", () => {
    // An invented action would fall through classifyAction's unknown-action
    // default to medium/reversible and auto-execute. This is the throw that
    // stops a model naming its way past the approval gate.
    expect(() =>
      validateSelection(
        { ...GOOD_RESPONSE, ranked: [{ action: "buy_backlinks", rationale: "r", confidence: 1 }] },
        pack(),
      ),
    ).toThrow(ActionOutsideAllowListError);
  });

  it("rejects a forbidden action even if a pack somehow listed it", () => {
    // Defence in depth: `allowed_actions` is built by the pack builder, and the
    // day a bug puts a CRITICAL action in one, this still refuses it.
    expect(() =>
      validateSelection(
        { ...GOOD_RESPONSE, ranked: [{ action: "site_redesign", rationale: "r", confidence: 1 }] },
        pack({ allowed_actions: ["site_redesign"] }),
      ),
    ).toThrow(ActionOutsideAllowListError);
  });

  it("rejects a whole response for one bad entry, rather than keeping the good ones", () => {
    // Silently dropping the offending entry would make an out-of-bounds answer
    // look like a successful one, and nobody would learn the model did it.
    expect(() =>
      validateSelection(
        {
          ...GOOD_RESPONSE,
          ranked: [
            { action: "page_speed_optimization", rationale: "fine", confidence: 0.8 },
            { action: "domain_migration", rationale: "not fine", confidence: 0.9 },
          ],
        },
        pack(),
      ),
    ).toThrow(ActionOutsideAllowListError);
  });

  it("validates against THIS pack, not a global list", () => {
    // page_speed_optimization is allow-listed for page_experience_repair but not
    // for keyword_recovery. A global check would accept it for either.
    expect(() =>
      validateSelection(GOOD_RESPONSE, pack({ allowed_actions: ["meta_title_update"] })),
    ).toThrow(ActionOutsideAllowListError);
  });

  it("rejects malformed shapes rather than coercing them", () => {
    for (const bad of [
      {},
      { summary: "s", ranked: [] },
      { summary: "s", ranked: [{ action: "page_speed_optimization" }] },
      { summary: "", ranked: GOOD_RESPONSE.ranked },
      {
        summary: "s",
        ranked: [{ action: "page_speed_optimization", rationale: "r", confidence: 4 }],
      },
      null,
      "page_speed_optimization",
    ]) {
      expect(() => validateSelection(bad, pack()), JSON.stringify(bad)).toThrow();
    }
  });

  it("caps an action id at the width of the column an approval writes it to", () => {
    // action_log.selected_option is varchar(50). A longer id would produce an
    // option nobody could approve, failing at the POST rather than here.
    expect(() =>
      validateSelection(
        { summary: "s", ranked: [{ action: "a".repeat(51), rationale: "r", confidence: 0.5 }] },
        pack({ allowed_actions: ["a".repeat(51)] }),
      ),
    ).toThrow();
  });

  it("caps the ranking length", () => {
    const ranked = Array.from({ length: MAX_RANKED_ACTIONS + 1 }, () => ({
      action: "page_speed_optimization",
      rationale: "r",
      confidence: 0.5,
    }));
    expect(() => validateSelection({ summary: "s", ranked }, pack())).toThrow();
  });

  it("collapses a duplicated action to its highest-ranked occurrence", () => {
    const selection = validateSelection(
      {
        summary: "s",
        ranked: [
          { action: "page_speed_optimization", rationale: "first", confidence: 0.9 },
          { action: "page_speed_optimization", rationale: "again", confidence: 0.2 },
        ],
      },
      pack(),
    );
    expect(selection.ranked).toHaveLength(1);
    expect(selection.ranked[0].rationale).toBe("first");
  });
});

// ─── Risk labelling stays with the execution policy ──────────────────────────

describe("selectionToOptions", () => {
  it("takes risk and reversibility from the taxonomy, never from the model", () => {
    // The model ranked the options; it does not get to say how dangerous they
    // are. page_speed_optimization is medium/reversible in the taxonomy.
    const options = selectionToOptions(validateSelection(GOOD_RESPONSE, pack()));
    expect(options[0].riskLevel).toBe("medium");
    expect(options[0].reversible).toBe(true);
  });

  it("marks only the top choice recommended and keeps the action as the option id", () => {
    const options = selectionToOptions(validateSelection(GOOD_RESPONSE, pack()));
    expect(options.map((option) => option.recommended)).toEqual([true, false]);
    expect(options[0].id).toBe("page_speed_optimization");
  });
});

// ─── Degradation ─────────────────────────────────────────────────────────────

describe("synthesizeActionSelection", () => {
  it("returns a validated selection on the happy path", async () => {
    const selection = await synthesizeActionSelection(pack(), CLIENT);
    expect(selection?.ranked.map((entry) => entry.action)).toEqual([
      "page_speed_optimization",
      "css_performance_fix",
    ]);
    expect(llm.calls[0].operation).toBe("INTELLIGENCE_ACTION_SELECTION");
  });

  it("returns null — never throws — when the model is unavailable or over budget", async () => {
    llm.throws = new Error("DailyBudgetExhausted");
    await expect(synthesizeActionSelection(pack(), CLIENT)).resolves.toBeNull();
  });

  it("returns null when the model reaches outside the allow-list", async () => {
    llm.response = {
      summary: "s",
      ranked: [{ action: "buy_backlinks", rationale: "r", confidence: 1 }],
    };
    await expect(synthesizeActionSelection(pack(), CLIENT)).resolves.toBeNull();
  });

  it("does not call a model at all when there is nothing to rank", async () => {
    // budget_review and pipeline_repair have no site-change remedy; asking would
    // spend tokens to be told so.
    await expect(
      synthesizeActionSelection(pack({ allowed_actions: [] }), CLIENT),
    ).resolves.toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it("sends the pack and nothing else — no database, no search", async () => {
    await synthesizeActionSelection(pack(), CLIENT);
    const args = llm.calls[0].args as { userPrompt: string; systemPrompt: string };
    expect(args.userPrompt).toContain("page_experience_repair");
    expect(args.systemPrompt).toContain("allowed_actions");
    // The pack is already proven redacted; nothing identifying should appear.
    expect(args.userPrompt).not.toMatch(/https?:\/\//);
    expect(args.userPrompt).not.toMatch(/@[\w-]+\./);
  });
});

// ─── The sweep ───────────────────────────────────────────────────────────────

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    actionLogId: "action-1",
    clientId: CLIENT,
    decisionId: "decision-1",
    evidenceSummary: pack(),
    ...overrides,
  };
}

describe("synthesizePendingProposals", () => {
  it("writes ranked options onto the proposal awaiting approval", async () => {
    db.selectQueue = [[pendingRow()]];
    const outcomes = await synthesizePendingProposals(10);

    expect(outcomes[0].optionCount).toBe(2);
    const written = db.updates.find((update) => update.table === "action_log");
    const options = (written?.values as { options?: unknown[] } | undefined)?.options;
    expect(Array.isArray(options)).toBe(true);
    expect(options).toHaveLength(2);
  });

  it("writes options as JSONB, not as a JSON string", async () => {
    // action_log.options is a jsonb column. logAction stringifies into it, which
    // the dashboard compensates for by parsing a string if it finds one; writing
    // the array properly is what that parser's other branch already expects.
    db.selectQueue = [[pendingRow()]];
    await synthesizePendingProposals(10);
    const written = db.updates.find((update) => update.table === "action_log");
    expect(typeof (written?.values as { options?: unknown } | undefined)?.options).not.toBe(
      "string",
    );
  });

  it("does nothing at all when LLM planning is disabled", async () => {
    // The plane must function with the model off; every proposal simply keeps
    // the action its deterministic template chose.
    config.enabled = false;
    db.selectQueue = [[pendingRow()]];

    await expect(synthesizePendingProposals(10)).resolves.toEqual([]);
    expect(llm.calls).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it("marks a proposal it could not rank, so it is not retried every sweep", async () => {
    // An empty options array is still a write: without it, a proposal the model
    // kept refusing would be re-sent hourly at the operator's expense.
    llm.throws = new Error("model unavailable");
    db.selectQueue = [[pendingRow()]];

    const outcomes = await synthesizePendingProposals(10);
    expect(outcomes[0].optionCount).toBe(0);
    const written = db.updates.find((update) => update.table === "action_log");
    expect((written?.values as { options?: unknown[] } | undefined)?.options).toEqual([]);
    // No invented recommendation to accompany a failure.
    expect(written?.values).not.toHaveProperty("aiRecommendation");
  });

  it("skips a decision with no evidence pack rather than inventing one", async () => {
    db.selectQueue = [[pendingRow({ evidenceSummary: {} })]];
    await expect(synthesizePendingProposals(10)).resolves.toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("records which actions were synthesized on the decision's policy basis", async () => {
    db.selectQueue = [[pendingRow()]];
    await synthesizePendingProposals(10);
    expect(db.updates.some((update) => update.table === "decisions")).toBe(true);
  });
});
