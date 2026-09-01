/* L9_META
 * layer: test
 * role: api_unit_test
 * status: active
 */

/**
 * The intelligence API is the egress point to an operator's browser, so these
 * tests check what LEAVES, not just what is returned.
 *
 * The important assertions are the negative ones. `clients` carries
 * `posthogApiKey` and a free-form `config` blob, and the standard way those
 * leak is `SELECT *` followed by `return rows`. Rather than asserting a
 * hand-picked field is absent, the secret tests seed the DB rows WITH secrets
 * present and assert the serialized response contains none of them — which
 * catches a future `select()` that drops the explicit projection.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbResults = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("../../src/core/database/index.js", () => {
  const makeBuilder = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const m of ["from", "where", "orderBy", "limit", "groupBy"]) {
      p[m] = () => p;
    }
    return p;
  };
  const db = { select: () => makeBuilder(dbResults.queue.shift() ?? []) };
  return {
    getDb: () => db,
    schema: {
      clients: {},
      intelligenceSignals: {},
      intelligenceRuns: {},
      intelligenceOpportunities: {},
      intelligenceActionLinks: {},
      intelligenceDecisions: {},
    },
  };
});

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/modules/intelligence/capabilities.js", () => ({
  currentCapabilities: () => ({
    enabled: true,
    usesLlmPlanner: false,
    autoRouteLowRisk: false,
    portfolioBenchmark: false,
    maxOpportunitiesPerClient: 10,
    minScoreToPlan: 50,
    signalStaleDays: 14,
  }),
}));

import { registerIntelligenceRoutes } from "../../src/api/intelligence.js";

const CLIENT_A = "11111111-1111-1111-1111-111111111111";

let app: FastifyInstance;

beforeEach(async () => {
  dbResults.queue = [];
  app = Fastify();
  await registerIntelligenceRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/clients/:clientId/intelligence", () => {
  it("404s an unknown client rather than returning an empty list", async () => {
    // An empty 200 reads as "this client has no signals", which hides a typo'd id.
    dbResults.queue = [[]];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/intelligence`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Client not found" });
  });

  it("returns this client's signals, runs, and resolved capabilities", async () => {
    dbResults.queue = [
      [{ id: CLIENT_A, domain: "example.com" }],
      [
        {
          signalType: "keyword_drop",
          fingerprint: "fp-1",
          entityKey: "metal roofing",
          severity: "high",
          confidence: 0.6,
          status: "open",
          evidence: { keyword: "metal roofing" },
          firstSeenAt: new Date(),
          observedAt: new Date(),
        },
      ],
      [
        {
          runType: "extract_signals",
          mode: "observe",
          status: "completed",
          stats: {},
          startedAt: new Date(),
        },
      ],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/intelligence`,
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.clientId).toBe(CLIENT_A);
    expect(body.capabilities.enabled).toBe(true);
    expect(body.signals).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
  });

  it("never serializes posthogApiKey or the raw client config", async () => {
    // The client row is seeded WITH secrets: the projection must drop them.
    dbResults.queue = [
      [
        {
          id: CLIENT_A,
          domain: "example.com",
          posthogApiKey: "phc_SUPER_SECRET_VALUE",
          config: { internalToken: "tok_SECRET" },
        },
      ],
      [],
      [],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/intelligence`,
    });
    const raw = response.body;
    expect(raw).not.toContain("phc_SUPER_SECRET_VALUE");
    expect(raw).not.toContain("tok_SECRET");
    expect(raw).not.toContain("posthogApiKey");
  });
});

describe("GET /api/clients/:clientId/opportunities", () => {
  it("404s an unknown client", async () => {
    dbResults.queue = [[]];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/opportunities`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns scored opportunities with their routing outcomes", async () => {
    dbResults.queue = [
      [{ id: CLIENT_A }],
      [
        {
          id: "opp-1",
          opportunityType: "recover_keyword_ranking",
          fingerprint: "opp-fp",
          score: 62,
          expectedImpact: 75,
          confidence: 0.6,
          urgency: 0.8,
          effort: 0.8,
          risk: 0.4,
          status: "open",
          rationale: "keyword slipped",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        {
          opportunityId: "opp-1",
          action: "intelligence_generate_surpass_plan",
          jobName: "serp:generate-surpass-plan",
          status: "blocked",
          blockedReason: "INTELLIGENCE_AUTO_ROUTE_LOW_RISK=false",
          createdAt: new Date(),
        },
      ],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/opportunities`,
    });
    const body = response.json();
    expect(body.opportunities).toHaveLength(1);
    // A blocked route is visible to the operator, with its reason.
    expect(body.links[0].status).toBe("blocked");
    expect(body.links[0].blockedReason).toMatch(/AUTO_ROUTE_LOW_RISK/);
  });

  it("does not leak client secrets on the opportunities route either", async () => {
    dbResults.queue = [
      [{ id: CLIENT_A, posthogApiKey: "phc_LEAK", config: { k: "v_SECRET" } }],
      [],
      [],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/opportunities`,
    });
    expect(response.body).not.toContain("phc_LEAK");
    expect(response.body).not.toContain("v_SECRET");
  });
});

describe("GET /api/clients/:clientId/decisions", () => {
  it("404s an unknown client", async () => {
    dbResults.queue = [[]];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/decisions`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns deferrals with their policy basis, not just actions", async () => {
    // A ledger that records only what happened cannot distinguish "the gate
    // blocked this correctly" from "the loop never looked at it".
    dbResults.queue = [
      [{ id: CLIENT_A }],
      [
        {
          id: "dec-1",
          opportunityId: "opp-1",
          decisionType: "intelligence_queue_outreach",
          decision: "defer",
          rationale: "ranking circuit breaker is open",
          policyBasis: { rankingCircuitBreakerOpen: true, score: 41, minScoreToPlan: 50 },
          evidenceSummary: { opportunityType: "link_building" },
          requiresApproval: false,
          actionLogId: null,
          createdAt: new Date(),
        },
      ],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/decisions`,
    });
    const body = response.json();
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].decision).toBe("defer");
    expect(body.decisions[0].policyBasis).toMatchObject({ rankingCircuitBreakerOpen: true });
  });

  it("does not leak client secrets", async () => {
    dbResults.queue = [
      [{ id: CLIENT_A, posthogApiKey: "phc_LEAK", config: { k: "v_SECRET" } }],
      [],
    ];
    const response = await app.inject({
      method: "GET",
      url: `/api/clients/${CLIENT_A}/decisions`,
    });
    expect(response.body).not.toContain("phc_LEAK");
    expect(response.body).not.toContain("v_SECRET");
  });
});

describe("POST /api/clients/:clientId/intelligence/trigger", () => {
  it("rejects a phase outside the intelligence allow-list", async () => {
    // The allow-list is deliberately not derived from the scheduler registry: a
    // new job must not become externally reachable merely by existing.
    const response = await app.inject({
      method: "POST",
      url: `/api/clients/${CLIENT_A}/intelligence/trigger`,
      payload: { phase: "serp:execute-surpass-plans" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid phase/);
  });

  it("rejects a missing phase", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/clients/${CLIENT_A}/intelligence/trigger`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s an unknown client before queueing anything", async () => {
    dbResults.queue = [[]];
    const response = await app.inject({
      method: "POST",
      url: `/api/clients/${CLIENT_A}/intelligence/trigger`,
      payload: { phase: "intelligence:extract-signals" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("never exposes the portfolio benchmark as a per-client trigger", async () => {
    // It is the one cross-client query in the module; triggering it from a
    // client-scoped route would misrepresent what it reads.
    const response = await app.inject({
      method: "POST",
      url: `/api/clients/${CLIENT_A}/intelligence/trigger`,
      payload: { phase: "intelligence:portfolio-benchmark" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/intelligence/portfolio", () => {
  it("suppresses the benchmark below the anonymity threshold", async () => {
    // With one or two tenants an "anonymous" median is trivially re-identifiable.
    dbResults.queue = [
      [{ signalType: "keyword_drop", clientCount: 2, signalCount: 9, avgConfidence: 0.5 }],
    ];
    const response = await app.inject({ method: "GET", url: "/api/intelligence/portfolio" });
    const body = response.json();
    expect(body.suppressed).toBe(true);
    expect(body.benchmarks).toEqual([]);
    expect(body.reason).toMatch(/re-identification/);
  });

  it("returns aggregates once enough clients contribute", async () => {
    dbResults.queue = [
      [
        { signalType: "keyword_drop", clientCount: 5, signalCount: 40, avgConfidence: 0.44 },
        { signalType: "citation_loss", clientCount: 4, signalCount: 12, avgConfidence: 0.61 },
      ],
    ];
    const response = await app.inject({ method: "GET", url: "/api/intelligence/portfolio" });
    const body = response.json();
    expect(body.suppressed).toBe(false);
    expect(body.anonymized).toBe(true);
    expect(body.benchmarks).toHaveLength(2);
  });

  it("returns no client identifiers, domains, keywords, or URLs", async () => {
    dbResults.queue = [
      [{ signalType: "keyword_drop", clientCount: 5, signalCount: 40, avgConfidence: 0.44 }],
    ];
    const response = await app.inject({ method: "GET", url: "/api/intelligence/portfolio" });
    const raw = response.body;
    for (const key of ["clientId", "client_id", "domain", "entityKey", "url"]) {
      expect(raw).not.toContain(key);
    }
  });
});
