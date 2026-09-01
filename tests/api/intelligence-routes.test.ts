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
    },
  };
});

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/modules/intelligence/modes.js", () => ({
  currentIntelligenceMode: () => "observe",
  currentCapabilities: () => ({
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: false,
    routesSafeJobs: false,
    usesLlmPlanner: false,
    routesOutreach: false,
    routesSiteMutation: false,
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

  it("returns this client's signals and runs with the active mode", async () => {
    dbResults.queue = [
      [{ id: CLIENT_A, domain: "example.com" }],
      [
        {
          signalType: "keyword_drop",
          fingerprint: "fp-1",
          entityKey: "metal roofing",
          severity: "high",
          strength: 0.6,
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
    expect(body.mode).toBe("observe");
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
          score: 0.42,
          impact: 0.75,
          confidence: 0.6,
          effort: 0.5,
          risk: 0.2,
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
          outcome: "blocked",
          blockedReason: "safe job routing not permitted",
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
    expect(body.links[0].outcome).toBe("blocked");
    expect(body.links[0].blockedReason).toMatch(/not permitted/);
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

describe("GET /api/intelligence/portfolio", () => {
  it("suppresses the benchmark below the anonymity threshold", async () => {
    // With one or two tenants an "anonymous" median is trivially re-identifiable.
    dbResults.queue = [
      [{ signalType: "keyword_drop", clientCount: 2, signalCount: 9, avgStrength: 0.5 }],
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
        { signalType: "keyword_drop", clientCount: 5, signalCount: 40, avgStrength: 0.44 },
        { signalType: "citation_loss", clientCount: 4, signalCount: 12, avgStrength: 0.61 },
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
      [{ signalType: "keyword_drop", clientCount: 5, signalCount: 40, avgStrength: 0.44 }],
    ];
    const response = await app.inject({ method: "GET", url: "/api/intelligence/portfolio" });
    const raw = response.body;
    for (const key of ["clientId", "client_id", "domain", "entityKey", "url"]) {
      expect(raw).not.toContain(key);
    }
  });
});
