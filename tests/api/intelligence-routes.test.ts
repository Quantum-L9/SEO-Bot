/* L9_META
 * layer: test
 * role: api_unit_test
 * status: active
 */

/**
 * INTEL-API-001 — the operator surface.
 *
 * Two things are being defended here.
 *
 * LEAKAGE. `clients` holds `posthogApiKey` and a free-form `config` blob that
 * carries deployment credentials. The routes project named columns rather than
 * returning rows, and these tests seed a real secret and assert the response
 * body does not contain it — a check that keeps working when someone adds a
 * column later, which a shape assertion would not.
 *
 * SCOPE. Per-client routes must never return another client's rows, and the
 * portfolio route must stay closed by default, because a cross-tenant read is
 * forbidden unless explicitly authorized for anonymized benchmarking.
 */

import type { PGlite } from "@electric-sql/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  type ModeOptions,
  makeConfig,
  resetTables,
  schema,
  seedClient,
  silentLogger,
  type TestDb,
} from "../modules/intelligence/harness.js";

let db: TestDb;
let pg: PGlite;
let configOptions: ModeOptions = {};

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => db,
  get schema() {
    return schema;
  },
}));
vi.mock("../../src/core/logger.js", () => silentLogger);
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => makeConfig(configOptions),
}));

import { registerIntelligenceRoutes } from "../../src/api/intelligence.js";

let app: FastifyInstance;
let clientA: string;
let clientB: string;
const NOW = new Date("2026-08-31T12:00:00Z");

const LEAKED_KEY = "phx_live_secret_value_do_not_share_12345";
const LEAKED_TOKEN = "ghp_supersecrettoken0000000000000000";

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  configOptions = { INTELLIGENCE_MODE: "route_safe", INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: true };
  await resetTables(pg);

  clientA = await seedClient(db, {
    domain: "client-a.test",
    posthogApiKey: LEAKED_KEY,
    config: { site_deployment: { githubToken: LEAKED_TOKEN, websiteBotRepo: "owner/repo" } },
  });
  clientB = await seedClient(db, { domain: "client-b.test", posthogApiKey: "other-secret" });

  app = Fastify();
  registerIntelligenceRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});

async function seedSignal(clientId: string, subject: string): Promise<void> {
  await db.insert(schema.intelligenceSignals).values({
    clientId,
    signalType: "keyword_drop",
    fingerprint: `fp-${clientId}-${subject}`,
    severity: "critical",
    subject,
    evidence: { currentPosition: 11, previousPosition: 3 },
    status: "open",
    firstObservedAt: NOW,
    observedAt: NOW,
  });
}

async function seedOpportunity(
  clientId: string,
  fingerprint: string,
  score: number,
): Promise<void> {
  await db.insert(schema.intelligenceOpportunities).values({
    clientId,
    opportunityType: "recover_keyword_position",
    fingerprint,
    score,
    impact: 0.9,
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

describe("GET /api/clients/:clientId/intelligence", () => {
  it("returns only that client's signals", async () => {
    await seedSignal(clientA, "client a keyword");
    await seedSignal(clientB, "client b keyword");

    const response = await app.inject({ url: `/api/clients/${clientA}/intelligence` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].subject).toBe("client a keyword");
    expect(response.payload).not.toContain("client b keyword");
  });

  it("never exposes posthogApiKey or the raw client config", async () => {
    await seedSignal(clientA, "kw");
    const response = await app.inject({ url: `/api/clients/${clientA}/intelligence` });

    expect(response.payload).not.toContain(LEAKED_KEY);
    expect(response.payload).not.toContain(LEAKED_TOKEN);
    expect(response.payload).not.toContain("site_deployment");
    expect(response.json()).not.toHaveProperty("config");
  });

  it("reports the mode and capability flags so an operator can see what is enabled", async () => {
    const response = await app.inject({ url: `/api/clients/${clientA}/intelligence` });
    const body = response.json();
    expect(body.mode).toBe("route_safe");
    expect(body.capabilities).toEqual({
      llmPlanning: false,
      safeJobRouting: true,
      outreachRouting: false,
      siteMutation: false,
    });
  });

  it("404s for an unknown client", async () => {
    const response = await app.inject({
      url: "/api/clients/00000000-0000-0000-0000-000000000000/intelligence",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the client's runs", async () => {
    await db.insert(schema.intelligenceRuns).values({
      clientId: clientA,
      runType: "extract_signals",
      mode: "observe",
      status: "completed",
      startedAt: NOW,
      completedAt: NOW,
    });
    await db.insert(schema.intelligenceRuns).values({
      clientId: clientB,
      runType: "extract_signals",
      mode: "observe",
      status: "failed",
      error: "CLIENT B FAILURE",
      startedAt: NOW,
    });

    const response = await app.inject({ url: `/api/clients/${clientA}/intelligence` });
    expect(response.json().runs).toHaveLength(1);
    expect(response.payload).not.toContain("CLIENT B FAILURE");
  });
});

describe("GET /api/clients/:clientId/opportunities", () => {
  it("returns only that client's opportunities, highest score first", async () => {
    await seedOpportunity(clientA, "opp-a-low", 10);
    await seedOpportunity(clientA, "opp-a-high", 90);
    await seedOpportunity(clientB, "opp-b", 99);

    const response = await app.inject({ url: `/api/clients/${clientA}/opportunities` });
    const body = response.json();

    expect(body.opportunities.map((o: { fingerprint: string }) => o.fingerprint)).toEqual([
      "opp-a-high",
      "opp-a-low",
    ]);
    expect(response.payload).not.toContain("opp-b");
  });

  it("never exposes secrets", async () => {
    await seedOpportunity(clientA, "opp-a", 50);
    const response = await app.inject({ url: `/api/clients/${clientA}/opportunities` });
    expect(response.payload).not.toContain(LEAKED_KEY);
    expect(response.payload).not.toContain(LEAKED_TOKEN);
  });

  it("returns only that client's decisions", async () => {
    await db.insert(schema.intelligenceDecisions).values([
      {
        clientId: clientA,
        mode: "route_safe",
        source: "deterministic",
        proposedAction: "intelligence_generate_surpass_plan",
        decision: "routed",
      },
      {
        clientId: clientB,
        mode: "full",
        source: "llm",
        proposedAction: "intelligence_queue_outreach",
        decision: "blocked",
        blockedReason: "CLIENT B REASON",
      },
    ]);

    const response = await app.inject({ url: `/api/clients/${clientA}/opportunities` });
    expect(response.json().decisions).toHaveLength(1);
    expect(response.payload).not.toContain("CLIENT B REASON");
  });

  it("404s for an unknown client", async () => {
    const response = await app.inject({
      url: "/api/clients/00000000-0000-0000-0000-000000000000/opportunities",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /api/intelligence/portfolio", () => {
  it("is forbidden by default", async () => {
    await seedOpportunity(clientA, "opp-a", 50);
    const response = await app.inject({ url: "/api/intelligence/portfolio" });
    // Cross-tenant reads are closed unless explicitly authorized.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("INTELLIGENCE_PORTFOLIO_BENCHMARK");
  });

  it("returns anonymized aggregates only when explicitly enabled", async () => {
    configOptions = { INTELLIGENCE_MODE: "route_safe", INTELLIGENCE_PORTFOLIO_BENCHMARK: true };
    await seedOpportunity(clientA, "opp-a", 40);
    await seedOpportunity(clientB, "opp-b", 60);

    const response = await app.inject({ url: "/api/intelligence/portfolio" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.anonymized).toBe(true);
    expect(body.buckets).toEqual([
      { opportunityType: "recover_keyword_position", status: "open", count: 2, averageScore: 50 },
    ]);

    // Aggregates, and nothing that identifies a tenant.
    expect(response.payload).not.toContain(clientA);
    expect(response.payload).not.toContain(clientB);
    expect(response.payload).not.toContain("client-a.test");
    expect(response.payload).not.toContain("opp-a");
  });
});
