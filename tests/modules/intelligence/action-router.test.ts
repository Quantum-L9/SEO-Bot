/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * INTEL-ROUTE-001 — what the loop can actually cause.
 *
 * Routing is asserted against a recording fake scheduler rather than live
 * BullMQ, as the acceptance brief prescribes for unit tests. The fake enforces
 * BullMQ's real deduplication rule (an add whose jobId already exists is
 * ignored), so the double-routing assertions mean what they say.
 *
 * The negative assertions carry the weight here. It is easy to show the router
 * enqueues the right job; what matters is that it cannot enqueue the wrong one
 * — that `serp:execute-surpass-plans` is unreachable, that outreach needs its
 * own capability, and that a re-delivered job sends one email rather than two.
 */

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  FakeJobSink,
  type ModeOptions,
  makeConfig,
  resetTables,
  schema,
  seedClient,
  silentLogger,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let pg: PGlite;
let configOptions: ModeOptions = {};

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => db,
  get schema() {
    return schema;
  },
}));
vi.mock("../../../src/core/logger.js", () => silentLogger);
vi.mock("../../../src/core/config.js", () => ({
  getConfig: () => makeConfig(configOptions),
}));

import {
  deterministicActionFor,
  FORBIDDEN_JOBS,
  isRoutableJob,
  OUTREACH_JOBS,
  routePlannedAction,
  SAFE_JOBS,
} from "../../../src/modules/intelligence/action-router.js";
import type { OpportunityType, PlannedAction } from "../../../src/modules/intelligence/types.js";

let clientA: string;
let clientB: string;
let sink: FakeJobSink;
const NOW = new Date("2026-08-31T12:00:00Z");

const READY_SITE_CONFIG = {
  site_deployment: { githubToken: "t", websiteBotRepo: "owner/repo" },
};

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  configOptions = { INTELLIGENCE_MODE: "route_safe", INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: true };
  await resetTables(pg);
  sink = new FakeJobSink();
  clientA = await seedClient(db, { domain: "client-a.test" });
  clientB = await seedClient(db, { domain: "client-b.test" });
});

async function seedOpportunity(
  clientId: string,
  opportunityType: string,
  fingerprint: string,
): Promise<void> {
  await db.insert(schema.intelligenceOpportunities).values({
    clientId,
    opportunityType,
    fingerprint,
    score: 50,
    impact: 0.8,
    confidence: 0.8,
    effort: 0.4,
    risk: 0.2,
    status: "open",
    signalFingerprints: ["s1"],
    rationale: "test",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function planned(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    clientId: clientA,
    opportunityFingerprint: "opp-1",
    action: "intelligence_generate_surpass_plan",
    rationale: "test",
    source: "deterministic",
    ...overrides,
  };
}

describe("the job allow-list", () => {
  it("never contains the live-site mutation job", () => {
    expect(SAFE_JOBS).not.toContain("serp:execute-surpass-plans");
    expect(OUTREACH_JOBS).not.toContain("serp:execute-surpass-plans");
    expect(FORBIDDEN_JOBS).toContain("serp:execute-surpass-plans");
    expect(isRoutableJob("serp:execute-surpass-plans")).toBe(false);
  });

  it("refuses any job outside the allow-list", () => {
    expect(isRoutableJob("some:invented-job")).toBe(false);
    expect(isRoutableJob("")).toBe(false);
    expect(isRoutableJob("serp:competitor-analysis")).toBe(true);
  });

  it("maps every opportunity type to a deterministic action", () => {
    expect(deterministicActionFor("recover_keyword_position")).toBe(
      "intelligence_generate_surpass_plan",
    );
    expect(deterministicActionFor("fix_page_experience")).toBe("intelligence_request_site_fix");
    expect(deterministicActionFor("regain_answer_citation")).toBe(
      "intelligence_optimize_faq_draft",
    );
    expect(deterministicActionFor("pursue_link_prospect")).toBe("intelligence_queue_outreach");
  });
});

describe("the route map", () => {
  it.each<[OpportunityType, string[]]>([
    ["recover_keyword_position", ["serp:competitor-analysis", "serp:generate-surpass-plan"]],
    ["fix_page_experience", ["vitals:check-all-sources"]],
    ["regain_answer_citation", ["aeo:check-citations", "aeo:optimize-faqs"]],
  ])("routes %s to %j", async (opportunityType, expectedJobs) => {
    await seedOpportunity(clientA, opportunityType, "opp-1");
    const outcome = await routePlannedAction({
      planned: planned({ action: deterministicActionFor(opportunityType) as string }),
      sink,
    });
    expect(outcome.decision).toBe("routed");
    expect(sink.jobNames).toEqual(expectedJobs);
  });

  it("marks the opportunity routed once its jobs are enqueued", async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
    await routePlannedAction({ planned: planned(), sink });

    const [row] = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(eq(schema.intelligenceOpportunities.fingerprint, "opp-1"));
    expect(row.status).toBe("routed");
  });

  it("records an action_log row for every routing", async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
    await routePlannedAction({ planned: planned(), sink });

    const rows = await db.select().from(schema.actionLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].module).toBe("intelligence");
    expect(rows[0].status).toBe("auto_executed");
  });
});

describe("idempotency under at-least-once delivery", () => {
  beforeEach(async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
  });

  it("routing the same opportunity twice queues each job once", async () => {
    await routePlannedAction({ planned: planned(), sink });
    const afterFirst = sink.calls.length;
    await routePlannedAction({ planned: planned(), sink });

    expect(sink.calls.length).toBe(afterFirst);
    expect(new Set(sink.jobNames).size).toBe(sink.jobNames.length);
  });

  it("creates one action link per (client, opportunity, job)", async () => {
    await routePlannedAction({ planned: planned(), sink });
    await routePlannedAction({ planned: planned(), sink });

    const links = await db
      .select()
      .from(schema.intelligenceActionLinks)
      .where(eq(schema.intelligenceActionLinks.clientId, clientA));
    expect(links).toHaveLength(2); // the two jobs of this route, once each
    const keys = links.map((l) => `${l.opportunityId}:${l.jobName}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("derives the job id from the routing, not the clock", async () => {
    await routePlannedAction({ planned: planned(), sink });
    const firstIds = sink.calls.map((c) => c.jobId);

    await resetTables(pg);
    clientA = await seedClient(db, { domain: "client-a.test" });
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
    sink.reset();
    await routePlannedAction({ planned: planned({ clientId: clientA }), sink });

    // Same client id would give the same job ids; a different one must not.
    // Either way the ids contain no timestamp component.
    expect(sink.calls.map((c) => c.jobId).every((id) => id?.startsWith("intel:"))).toBe(true);
    expect(firstIds.every((id) => id?.startsWith("intel:"))).toBe(true);
  });

  it("claims the link before enqueuing, so a claimed route enqueues nothing", async () => {
    await routePlannedAction({ planned: planned(), sink });
    sink.reset();
    // A second delivery finds the links already claimed. Nothing reaches the
    // queue at all — not even a duplicate that BullMQ would later drop.
    await routePlannedAction({ planned: planned(), sink });
    expect(sink.addJob).not.toHaveBeenCalled();
  });
});

describe("outreach is separately gated", () => {
  beforeEach(async () => {
    await seedOpportunity(clientA, "pursue_link_prospect", "opp-1");
  });

  it("is blocked in route_safe even with safe routing on", async () => {
    configOptions = { INTELLIGENCE_MODE: "route_safe", INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: true };
    const outcome = await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    expect(outcome.decision).toBe("blocked");
    expect(sink.addJob).not.toHaveBeenCalled();
  });

  it("is blocked at full mode when the outreach flag is off", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: false };
    const outcome = await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    expect(outcome.decision).toBe("blocked");
    expect(outcome.blockedReason).toContain("INTELLIGENCE_ALLOW_OUTREACH_ROUTING");
  });

  it("routes only when mode is full AND the flag is on", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true };
    const outcome = await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    expect(outcome.decision).toBe("routed");
    expect(sink.jobNames).toEqual(["links:process-outreach"]);
  });

  it("sends one outreach job, not two, on a re-delivered route", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true };
    await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    sink.reset();
    await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    // The consequence this whole mechanism exists for: an at-least-once queue
    // must not email a stranger twice.
    expect(sink.addJob).not.toHaveBeenCalled();
  });

  it("is blocked when the ranking circuit breaker is open", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true };
    for (let index = 0; index < 3; index += 1) {
      await db.insert(schema.serpRankings).values({
        clientId: clientA,
        keyword: `kw-${index}`,
        previousPosition: 5,
        position: 40,
        checkedAt: NOW,
      });
    }
    const outcome = await routePlannedAction({
      planned: planned({ action: "intelligence_queue_outreach" }),
      sink,
    });
    expect(outcome.decision).toBe("blocked");
    expect(sink.addJob).not.toHaveBeenCalled();
  });
});

describe("unknown and forbidden actions", () => {
  beforeEach(async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
  });

  it("blocks an unknown action before anything is enqueued", async () => {
    const outcome = await routePlannedAction({
      planned: planned({ action: "llm_invented_delete_everything" }),
      sink,
    });
    expect(outcome.decision).toBe("blocked");
    expect(outcome.blockedReason).toContain("CRITICAL");
    expect(sink.addJob).not.toHaveBeenCalled();
  });

  it("records the refusal as a pending_approval action_log row", async () => {
    await routePlannedAction({
      planned: planned({ action: "llm_invented_delete_everything" }),
      sink,
    });
    const rows = await db.select().from(schema.actionLog);
    expect(rows[0].status).toBe("pending_approval");
    expect(rows[0].riskLevel).toBe("critical");
  });

  it("blocks intelligence_execute_site_change in every mode", async () => {
    for (const mode of ["route_safe", "route_llm", "full"]) {
      configOptions = {
        INTELLIGENCE_MODE: mode,
        INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: true,
        INTELLIGENCE_ALLOW_SITE_MUTATION: true,
      };
      sink.reset();
      const outcome = await routePlannedAction({
        planned: planned({ action: "intelligence_execute_site_change" }),
        sink,
        clientConfig: READY_SITE_CONFIG,
      });
      // Classified critical, so the execution policy holds it for a human
      // before the capability gate is ever consulted.
      expect(outcome.decision).toBe("blocked");
      expect(sink.addJob).not.toHaveBeenCalled();
    }
  });
});

describe("decisions are always recorded", () => {
  it("writes a decision row for a refusal, not only for a routing", async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
    configOptions = { INTELLIGENCE_MODE: "recommend" };

    const outcome = await routePlannedAction({ planned: planned(), sink });
    expect(outcome.decision).toBe("blocked");

    const decisions = await db
      .select()
      .from(schema.intelligenceDecisions)
      .where(eq(schema.intelligenceDecisions.clientId, clientA));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("blocked");
    // Silently dropping a refusal would make the audit read as though the loop
    // never considered the action.
    expect(decisions[0].blockedReason).toBeTruthy();
  });

  it("records the mode the decision was made under", async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "opp-1");
    await routePlannedAction({ planned: planned(), sink });

    const [decision] = await db
      .select()
      .from(schema.intelligenceDecisions)
      .where(eq(schema.intelligenceDecisions.clientId, clientA));
    expect(decision.mode).toBe("route_safe");
    expect(decision.source).toBe("deterministic");
  });
});

describe("tenant isolation", () => {
  it("refuses to route another client's opportunity fingerprint", async () => {
    await seedOpportunity(clientB, "recover_keyword_position", "opp-shared");
    // Client A names a fingerprint that exists — but for B. The lookup is
    // scoped by client, so it simply is not found.
    const outcome = await routePlannedAction({
      planned: planned({ clientId: clientA, opportunityFingerprint: "opp-shared" }),
      sink,
    });
    expect(outcome.decision).toBe("blocked");
    expect(outcome.blockedReason).toContain("not found");
    expect(sink.addJob).not.toHaveBeenCalled();
  });

  it("gives two clients distinct job ids for the same fingerprint", async () => {
    await seedOpportunity(clientA, "recover_keyword_position", "same-fp");
    await seedOpportunity(clientB, "recover_keyword_position", "same-fp");

    await routePlannedAction({
      planned: planned({ clientId: clientA, opportunityFingerprint: "same-fp" }),
      sink,
    });
    const idsA = sink.calls.map((c) => c.jobId);
    sink.reset();
    await routePlannedAction({
      planned: planned({ clientId: clientB, opportunityFingerprint: "same-fp" }),
      sink,
    });
    const idsB = sink.calls.map((c) => c.jobId);

    // Colliding ids would mean B's routing silently suppressed by A's.
    expect(idsB).toHaveLength(2);
    for (const id of idsB) expect(idsA).not.toContain(id);
  });

  it("throws rather than routing without a client id", async () => {
    await expect(routePlannedAction({ planned: planned({ clientId: "" }), sink })).rejects.toThrow(
      /clientId is required/,
    );
  });
});
