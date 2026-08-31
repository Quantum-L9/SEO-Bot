/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The lifecycle is what stops the plane suppressing the problems it failed to
 * fix. Two behaviors carry that weight, and both fail SILENTLY when wrong:
 *
 *  - A verdict that closes an opportunity it should have reopened. `declined`
 *    and `unchanged` mean the remedy did not work and the problem is still
 *    there; marking those `resolved` would leave the fingerprint suppressed
 *    behind a terminal status and the bot would never look at it again.
 *  - An approved action nobody measures. `evaluateExecution` sends CRITICAL
 *    actions to the approval queue; before the sweep, an approval produced no
 *    outcome row, no window, and no follow-up job — so the highest-risk changes
 *    were the least measured.
 *
 * Both are asserted here against the real transition rules, plus the claim
 * ordering that keeps a retried sweep from measuring the same change twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

const tables = vi.hoisted(() => ({
  intelligenceOpportunities: {
    __table: "opportunities",
    id: "opportunities.id",
    clientId: "opportunities.client_id",
    status: "opportunities.status",
    fingerprint: "opportunities.fingerprint",
    updatedAt: "opportunities.updated_at",
    createdAt: "opportunities.created_at",
    targetUrl: "opportunities.target_url",
    targetKeyword: "opportunities.target_keyword",
    evidence: "opportunities.evidence",
    opportunityType: "opportunities.opportunity_type",
  },
  intelligenceDecisions: {
    __table: "decisions",
    id: "decisions.id",
    opportunityId: "decisions.opportunity_id",
    actionLogId: "decisions.action_log_id",
  },
  intelligenceExperiments: { __table: "experiments", id: "experiments.id" },
  actionOutcomes: { __table: "action_outcomes", id: "action_outcomes.id" },
  actionLog: {
    __table: "action_log",
    id: "action_log.id",
    clientId: "action_log.client_id",
    action: "action_log.action",
    module: "action_log.module",
    status: "action_log.status",
    approvedAt: "action_log.approved_at",
    executedAt: "action_log.executed_at",
  },
}));

const db = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown }[],
  updates: [] as { table: string; values: unknown }[],
  /** Rows the next select() resolves to, consumed FIFO. */
  selectQueue: [] as unknown[],
  /** Rows the next update().returning() resolves to; empty = guard rejected. */
  updateReturns: [] as unknown[],
}));

vi.mock("../../src/core/database/index.js", () => {
  const thenable = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const method of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) {
      p[method] = () => p;
    }
    return p;
  };

  const instance = {
    insert: (table: { __table: string }) => ({
      values: (values: unknown) => ({
        returning: () => {
          db.inserts.push({ table: table.__table, values });
          return Promise.resolve([{ id: `${table.__table}-id-${db.inserts.length}` }]);
        },
      }),
    }),
    update: (table: { __table: string }) => ({
      set: (values: unknown) => ({
        where: () => {
          db.updates.push({ table: table.__table, values });
          const rows = db.updateReturns.shift() ?? [{ id: `${table.__table}-updated` }];
          const settled = Promise.resolve(rows) as Promise<unknown> & {
            returning: () => Promise<unknown>;
          };
          settled.returning = () => Promise.resolve(rows);
          return settled;
        },
      }),
    }),
    select: () => thenable(db.selectQueue.shift() ?? []),
  };
  return { getDb: () => instance, schema: tables };
});

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    INTELLIGENCE_BASELINE_DAYS: 14,
    INTELLIGENCE_MEASUREMENT_DAYS: 28,
    INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: 30,
    INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
  }),
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  ACTIVE_OPPORTUNITY_STATUSES,
  applyVerdictToOpportunity,
  assertLifecycleConfig,
  attributionEntityFromStored,
  expireStaleOpportunities,
  markOpportunityActioned,
  OPPORTUNITY_STATUSES,
  statusForVerdict,
  sweepApprovedActions,
  TERMINAL_OPPORTUNITY_STATUSES,
} from "../../src/intelligence/lifecycle.js";

const addJob = vi.fn();
const scheduler = { addJob } as unknown as never;

function rowsFor(table: string): Record<string, unknown>[] {
  return db.inserts
    .filter((insert) => insert.table === table)
    .map((insert) => insert.values as Record<string, unknown>);
}

function updatesFor(table: string): Record<string, unknown>[] {
  return db.updates
    .filter((update) => update.table === table)
    .map((update) => update.values as Record<string, unknown>);
}

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.selectQueue = [];
  db.updateReturns = [];
  addJob.mockClear();
});

// ─── The transition rule ─────────────────────────────────────────────────────

describe("statusForVerdict", () => {
  it("resolves only on a measured improvement", () => {
    expect(statusForVerdict("improved")).toBe("resolved");
  });

  it("REOPENS on a refuted or flat remedy rather than closing it", () => {
    // This is the whole point of the contract. A remedy that did not work
    // leaves the problem in place; closing the opportunity would suppress its
    // fingerprint behind a terminal status and the bot would go quiet on
    // exactly the problems it failed to fix.
    expect(statusForVerdict("declined")).toBe("open");
    expect(statusForVerdict("unchanged")).toBe("open");
  });

  it("invents no transition from an absence of evidence", () => {
    expect(statusForVerdict("inconclusive")).toBeNull();
  });

  it("keeps the status vocabulary closed and the terminal set disjoint from the live set", () => {
    expect([...OPPORTUNITY_STATUSES].sort()).toEqual([
      "actioned",
      "expired",
      "open",
      "resolved",
    ]);
    for (const status of TERMINAL_OPPORTUNITY_STATUSES) {
      expect(ACTIVE_OPPORTUNITY_STATUSES).not.toContain(status);
    }
  });
});

describe("markOpportunityActioned", () => {
  it("moves an open opportunity to actioned", async () => {
    await expect(markOpportunityActioned("opp-1")).resolves.toBe(true);
    expect(updatesFor("opportunities")[0].status).toBe("actioned");
  });

  it("reports false when the status guard rejected the move", async () => {
    // A resolved or expired opportunity must not be walked backwards by a
    // retried run — BullMQ is at-least-once.
    db.updateReturns = [[]];
    await expect(markOpportunityActioned("opp-1")).resolves.toBe(false);
  });
});

describe("applyVerdictToOpportunity", () => {
  it("resolves the opportunity behind an improved experiment", async () => {
    db.selectQueue = [[{ opportunityId: "opp-7" }]];
    const result = await applyVerdictToOpportunity("decision-1", "improved");
    expect(result).toEqual({ opportunityId: "opp-7", status: "resolved" });
    expect(updatesFor("opportunities")[0].status).toBe("resolved");
  });

  it("reopens the opportunity behind a declined experiment", async () => {
    db.selectQueue = [[{ opportunityId: "opp-7" }]];
    const result = await applyVerdictToOpportunity("decision-1", "declined");
    expect(result?.status).toBe("open");
  });

  it("writes nothing for an inconclusive verdict — and does not even look up the decision", async () => {
    db.selectQueue = [[{ opportunityId: "opp-7" }]];
    const result = await applyVerdictToOpportunity("decision-1", "inconclusive");

    expect(result).toBeNull();
    expect(updatesFor("opportunities")).toHaveLength(0);
    // The queued decision row is untouched: too little data to judge is not a
    // reason to move an opportunity anywhere.
    expect(db.selectQueue).toHaveLength(1);
  });

  it("tolerates an orphaned link instead of throwing", async () => {
    // A decision with a null opportunity_id is the orphaned-FK case. One broken
    // link must not abort a whole attribution pass.
    db.selectQueue = [[{ opportunityId: null }]];
    await expect(applyVerdictToOpportunity("decision-1", "improved")).resolves.toBeNull();

    await expect(applyVerdictToOpportunity(null, "improved")).resolves.toBeNull();
  });

  it("does not transition an opportunity that is no longer actioned", async () => {
    db.selectQueue = [[{ opportunityId: "opp-7" }]];
    db.updateReturns = [[]];
    await expect(applyVerdictToOpportunity("decision-1", "improved")).resolves.toBeNull();
  });
});

describe("expireStaleOpportunities", () => {
  it("expires aged rows and reports how many moved", async () => {
    db.updateReturns = [[{ id: "opp-1" }, { id: "opp-2" }]];
    await expect(expireStaleOpportunities(new Date("2026-08-31T00:00:00Z"), 30)).resolves.toBe(2);
    expect(updatesFor("opportunities")[0].status).toBe("expired");
  });

  it("is a no-op when nothing has aged out", async () => {
    db.updateReturns = [[]];
    await expect(expireStaleOpportunities(new Date(), 30)).resolves.toBe(0);
  });
});

describe("assertLifecycleConfig", () => {
  it("accepts an expiry window that outlasts the cooldown", () => {
    expect(() =>
      assertLifecycleConfig({
        INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: 30,
        INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
      }),
    ).not.toThrow();
  });

  it("rejects an expiry window inside the cooldown", () => {
    // Inside the cooldown a repeat observation is suppressed and writes no new
    // opportunity row. An expiry window shorter than that reads ordinary
    // suppression as the problem going away, and expires live work.
    for (const expiry of [7, 3]) {
      expect(() =>
        assertLifecycleConfig({
          INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: expiry,
          INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
        }),
      ).toThrow(/must exceed/);
    }
  });
});

// ─── Attribution entity from a stored row ────────────────────────────────────

describe("attributionEntityFromStored", () => {
  const row = {
    targetKeyword: "roofing austin",
    targetUrl: "/roofing",
    evidence: {
      signals: [
        { signal_type: "keyword_drop", evidence: { keyword: "roofing austin" } },
        { signal_type: "citation_rate_down", evidence: { platform: "perplexity" } },
      ],
    },
  };

  it("measures SERP position against the keyword and exit rate against the page", () => {
    expect(attributionEntityFromStored("serp_position", row)).toBe("roofing austin");
    expect(attributionEntityFromStored("page_exit_rate", row)).toBe("/roofing");
  });

  it("recovers the platform for citation rate from the stored signal evidence", () => {
    // The sweep runs long after the run that produced the opportunity, so the
    // platform is only available as the JSON the scorer wrote.
    expect(attributionEntityFromStored("aeo_citation_rate", row)).toBe("perplexity");
  });

  it("returns null rather than guessing when no platform was recorded", () => {
    expect(
      attributionEntityFromStored("aeo_citation_rate", { ...row, evidence: { signals: [] } }),
    ).toBeNull();
    expect(attributionEntityFromStored("aeo_citation_rate", { ...row, evidence: null })).toBeNull();
  });
});

// ─── The approved-action sweep ───────────────────────────────────────────────

const APPROVED_AT = new Date("2026-08-20T09:00:00Z");

function approvedRow(overrides: Record<string, unknown> = {}) {
  return {
    actionLogId: "action-1",
    clientId: CLIENT,
    action: "site_redesign",
    module: "serp-intelligence",
    approvedAt: APPROVED_AT,
    decisionId: "decision-1",
    opportunityId: "opp-1",
    opportunityType: "keyword_drop_plus_page_experience",
    targetUrl: "/roofing",
    targetKeyword: "roofing austin",
    evidence: { signals: [] },
    ...overrides,
  };
}

describe("sweepApprovedActions", () => {
  it("gives an approved action the outcome row, window and follow-up job an auto-executed one gets", async () => {
    db.selectQueue = [[approvedRow()]];
    const pickups = await sweepApprovedActions(scheduler, new Date("2026-08-21T00:00:00Z"));

    expect(pickups).toHaveLength(1);
    expect(rowsFor("action_outcomes")).toHaveLength(1);
    expect(rowsFor("experiments")).toHaveLength(1);
    expect(addJob).toHaveBeenCalledWith("serp:generate-surpass-plan", { clientId: CLIENT });
  });

  it("anchors the baseline to the approval, not to the sweep", async () => {
    // Measuring from sweep time would shift every window by however long the
    // approval sat unread, and silently attribute the gap to the change.
    db.selectQueue = [[approvedRow()]];
    await sweepApprovedActions(scheduler, new Date("2026-08-25T00:00:00Z"));

    expect(rowsFor("action_outcomes")[0].executedAt).toEqual(APPROVED_AT);
    expect(rowsFor("experiments")[0].baselineEnd).toEqual(APPROVED_AT);
  });

  it("links the experiment back to the decision that proposed it", async () => {
    db.selectQueue = [[approvedRow()]];
    await sweepApprovedActions(scheduler);

    const experiment = rowsFor("experiments")[0];
    expect(experiment.decisionId).toBe("decision-1");
    expect(experiment.actionOutcomeId).toBeTruthy();
  });

  it("claims the row before acting, so a retried sweep cannot measure it twice", async () => {
    db.selectQueue = [[approvedRow()]];
    // The claim update finds nothing left to stamp — another sweep got there.
    db.updateReturns = [[]];
    const pickups = await sweepApprovedActions(scheduler);

    expect(pickups).toHaveLength(0);
    expect(rowsFor("action_outcomes")).toHaveLength(0);
    expect(rowsFor("experiments")).toHaveLength(0);
    expect(addJob).not.toHaveBeenCalled();
  });

  it("stamps executed_at as the claim marker so the next sweep skips it", async () => {
    db.selectQueue = [[approvedRow()]];
    await sweepApprovedActions(scheduler);
    expect(updatesFor("action_log")[0].executedAt).toBeInstanceOf(Date);
  });

  it("records the approval even when no metric can judge it", async () => {
    // budget_review has no plan template: its remedy is operator attention, not
    // a site change. The outcome row still exists; the window honestly does not.
    db.selectQueue = [[approvedRow({ opportunityType: "budget_review" })]];
    const pickups = await sweepApprovedActions(scheduler);

    expect(rowsFor("action_outcomes")).toHaveLength(1);
    expect(rowsFor("experiments")).toHaveLength(0);
    expect(pickups[0].experimentId).toBeNull();
  });

  it("moves the opportunity to actioned", async () => {
    db.selectQueue = [[approvedRow()]];
    await sweepApprovedActions(scheduler);
    expect(updatesFor("opportunities").some((row) => row.status === "actioned")).toBe(true);
  });

  it("queues nothing when no scheduler is available, but still opens the window", async () => {
    db.selectQueue = [[approvedRow()]];
    const pickups = await sweepApprovedActions(undefined);

    expect(addJob).not.toHaveBeenCalled();
    expect(pickups[0].followUpJobQueued).toBe(false);
    expect(rowsFor("experiments")).toHaveLength(1);
  });

  it("never queues the gated live-site write job", async () => {
    // AGENTS §9: serp:execute-surpass-plans stays off TRIGGERABLE_JOBS, and an
    // operator approval is not a licence for this plane to reach it.
    db.selectQueue = [[approvedRow()]];
    await sweepApprovedActions(scheduler);
    for (const [jobName] of addJob.mock.calls) {
      expect(jobName).not.toBe("serp:execute-surpass-plans");
    }
  });
});
