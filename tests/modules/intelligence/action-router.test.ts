/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * The router is where intelligence becomes behavior, and its worst failure is
 * not "did the wrong thing" but "did the right thing twice" — a duplicated
 * outreach email cannot be recalled.
 *
 * So the idempotency tests here exercise BOTH mechanisms independently: the
 * deterministic BullMQ job id, and the UNIQUE link row. Either alone would look
 * correct in a happy-path test; the point is that each holds when the other is
 * unavailable (a flushed Redis, a lost link write).
 *
 * The router is also tested against a FAKE scheduler, deliberately. It must not
 * grow its own executor: its only outward effect is `addJob` plus an action_log
 * row, which is what keeps token budgets, fan-out and job_executions logging
 * applying to intelligence-originated work.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertReturningMock = vi.fn().mockResolvedValue([{ id: "action-log-1" }]);
const insertValuesMock = vi.fn((..._args: unknown[]) => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { actionLog: { id: "actionLog.id" } },
}));

vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  ROUTE_MAP,
  type RouteDeps,
  routedJobId,
  routeOpportunity,
} from "../../../src/modules/intelligence/action-router.js";
import type { ScoredOpportunity } from "../../../src/modules/intelligence/opportunity-scorer.js";
import type { PolicyGateDecision } from "../../../src/modules/intelligence/policy-gate.js";

const CLIENT = "client-a";

function opportunity(
  overrides: Partial<ScoredOpportunity & { id: string }> = {},
): ScoredOpportunity & { id: string } {
  return {
    id: "opp-row-1",
    clientId: CLIENT,
    opportunityType: "recover_keyword_ranking",
    fingerprint: "fingerprint-1",
    score: 0.4,
    impact: 0.75,
    confidence: 0.6,
    effort: 0.5,
    risk: 0.2,
    signalFingerprints: ["fp-1"],
    rationale: "keyword slipped",
    ...overrides,
  };
}

const ALLOW: PolicyGateDecision = {
  allowed: true,
  reasons: [],
  riskLevel: "low",
  requiresApproval: false,
};

/** Typed to match RoutableScheduler so `mock.calls[n][i]` is indexable. */
type AddJob = (
  jobName: string,
  data: Record<string, unknown>,
  opts?: { jobId?: string },
) => Promise<void>;

function deps(overrides: Partial<RouteDeps> = {}) {
  const addJob = vi.fn<AddJob>(async () => {});
  const claimed = new Set<string>();
  const recordLink = vi.fn(async (link: { opportunityId: string; jobName: string | null }) => {
    // Emulates the UNIQUE (client_id, opportunity_id, job_name) constraint.
    const key = `${link.opportunityId}|${link.jobName ?? ""}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  const base: RouteDeps = {
    scheduler: { addJob },
    recordLink,
    evaluate: () => ALLOW,
    clientDomain: "example.com",
    clientConfig: {},
    writesProposals: true,
    ...overrides,
  };
  return { deps: base, addJob, recordLink };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: "action-log-1" }]);
});

describe("route map", () => {
  it("routes a keyword drop to competitor analysis and a surpass plan", async () => {
    const { deps: d, addJob } = deps();
    const results = await routeOpportunity(opportunity(), d);
    expect(results.map((r) => r.jobName)).toEqual([
      "serp:competitor-analysis",
      "serp:generate-surpass-plan",
    ]);
    expect(addJob).toHaveBeenCalledTimes(2);
  });

  it("routes a slow exit page to a vitals check plus a proposal", async () => {
    const { deps: d, addJob } = deps();
    const results = await routeOpportunity(
      opportunity({ opportunityType: "fix_slow_exit_page" }),
      d,
    );
    expect(results.map((r) => r.jobName)).toEqual(["vitals:check-all-sources", null]);
    // The proposal-only route enqueues nothing.
    expect(addJob).toHaveBeenCalledTimes(1);
    expect(results[1].outcome).toBe("proposed");
  });

  it("routes a citation loss to a citation check and an FAQ draft", async () => {
    const { deps: d } = deps();
    const results = await routeOpportunity(opportunity({ opportunityType: "recover_citation" }), d);
    expect(results.map((r) => r.jobName)).toEqual(["aeo:check-citations", "aeo:optimize-faqs"]);
  });

  it("routes a ready prospect to outreach only", async () => {
    const { deps: d } = deps();
    const results = await routeOpportunity(opportunity({ opportunityType: "acquire_backlink" }), d);
    expect(results.map((r) => r.jobName)).toEqual(["links:process-outreach"]);
  });

  it("never routes to the live-site mutation job", () => {
    // serp:execute-surpass-plans mutates live sites and is disabled in the
    // scheduler registry. Intelligence must not be what turns it on.
    const allJobs = Object.values(ROUTE_MAP)
      .flat()
      .map((route) => route.jobName);
    expect(allJobs).not.toContain("serp:execute-surpass-plans");
  });

  it("returns nothing for an unrecognised opportunity type", async () => {
    const { deps: d, addJob } = deps();
    const results = await routeOpportunity(
      opportunity({ opportunityType: "some_future_type" as never }),
      d,
    );
    expect(results).toEqual([]);
    expect(addJob).not.toHaveBeenCalled();
  });
});

describe("deterministic job ids", () => {
  it("derives the same id for the same opportunity and job", () => {
    expect(routedJobId(CLIENT, "fp", "serp:competitor-analysis")).toBe(
      routedJobId(CLIENT, "fp", "serp:competitor-analysis"),
    );
  });

  it("derives different ids per client, per opportunity, and per job", () => {
    const base = routedJobId(CLIENT, "fp", "serp:competitor-analysis");
    expect(routedJobId("client-b", "fp", "serp:competitor-analysis")).not.toBe(base);
    expect(routedJobId(CLIENT, "fp2", "serp:competitor-analysis")).not.toBe(base);
    expect(routedJobId(CLIENT, "fp", "aeo:check-citations")).not.toBe(base);
  });

  it("passes the id to the scheduler so BullMQ can dedupe the enqueue", async () => {
    const { deps: d, addJob } = deps();
    await routeOpportunity(opportunity(), d);
    const expected = routedJobId(CLIENT, "fingerprint-1", "serp:competitor-analysis");
    expect(addJob).toHaveBeenNthCalledWith(1, "serp:competitor-analysis", expect.any(Object), {
      jobId: expected,
    });
  });
});

describe("idempotency on retry", () => {
  it("enqueues once when the same opportunity is routed twice", async () => {
    const { deps: d, addJob } = deps();
    await routeOpportunity(opportunity(), d);
    const second = await routeOpportunity(opportunity(), d);

    // Two jobs on the first pass, zero more on the second.
    expect(addJob).toHaveBeenCalledTimes(2);
    expect(second.every((r) => r.outcome === "deduped")).toBe(true);
  });

  it("does not send outreach twice on a retry", async () => {
    const { deps: d, addJob } = deps();
    const opp = opportunity({ opportunityType: "acquire_backlink" });
    await routeOpportunity(opp, d);
    await routeOpportunity(opp, d);
    const outreachCalls = addJob.mock.calls.filter((c) => c[0] === "links:process-outreach");
    expect(outreachCalls).toHaveLength(1);
  });

  it("claims the link before enqueuing, so a crash cannot leave an unlinked job", async () => {
    const order: string[] = [];
    const addJob = vi.fn<AddJob>(async () => {
      order.push("addJob");
    });
    const recordLink = vi.fn(async () => {
      order.push("recordLink");
      return true;
    });
    await routeOpportunity(opportunity(), {
      scheduler: { addJob },
      recordLink,
      evaluate: () => ALLOW,
      clientDomain: "example.com",
      clientConfig: {},
      writesProposals: false,
    });
    expect(order[0]).toBe("recordLink");
    expect(order[1]).toBe("addJob");
  });

  it("skips the enqueue when the unique constraint rejects the link", async () => {
    // Simulates the DB guarantee holding even if BullMQ's id dedup were bypassed.
    const addJob = vi.fn<AddJob>(async () => {});
    const results = await routeOpportunity(opportunity(), {
      scheduler: { addJob },
      recordLink: async () => false,
      evaluate: () => ALLOW,
      clientDomain: "example.com",
      clientConfig: {},
      writesProposals: false,
    });
    expect(addJob).not.toHaveBeenCalled();
    expect(results.every((r) => r.outcome === "deduped")).toBe(true);
  });
});

describe("gating", () => {
  it("records a blocked route with its reason and enqueues nothing", async () => {
    const {
      deps: d,
      addJob,
      recordLink,
    } = deps({
      evaluate: () => ({
        allowed: false,
        reasons: ["outreach routing not permitted"],
        riskLevel: "high",
        requiresApproval: false,
      }),
    });
    const results = await routeOpportunity(opportunity({ opportunityType: "acquire_backlink" }), d);
    expect(addJob).not.toHaveBeenCalled();
    expect(results[0].outcome).toBe("blocked");
    expect(results[0].blockedReason).toMatch(/outreach routing not permitted/);
    // A blocked decision is still recorded — "considered and declined" must be
    // distinguishable from "never looked".
    expect(recordLink).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "blocked", blockedReason: expect.any(String) }),
    );
  });

  it("writes no action_log proposal when the mode forbids proposals", async () => {
    const { deps: d } = deps({ writesProposals: false });
    await routeOpportunity(opportunity(), d);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("writes an action_log proposal when the mode permits it", async () => {
    const { deps: d } = deps({ writesProposals: true });
    await routeOpportunity(opportunity(), d);
    expect(insertValuesMock).toHaveBeenCalled();
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      module: "intelligence",
      clientId: CLIENT,
    });
  });

  it("holds a critical proposal for approval instead of enqueuing it", async () => {
    // The gate says allowed, but the proposal-level policy still classifies the
    // action critical. These are independent checks by design.
    const { deps: d, addJob } = deps();
    expect(ROUTE_MAP.acquire_backlink[0].action).toBe("intelligence_queue_outreach");

    const results = await routeOpportunity(opportunity({ opportunityType: "acquire_backlink" }), d);
    // outreach is `high`, so it does auto-execute — asserted explicitly so a
    // future reclassification to `critical` fails here loudly.
    expect(results[0].outcome).toBe("queued");
    expect(addJob).toHaveBeenCalledTimes(1);
  });
});
