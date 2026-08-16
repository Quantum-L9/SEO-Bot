import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dashboard.ts pulls in db + logger at import. The escapeHtml unit tests need
// only inert stubs; the render-call-site (GAP-008) tests drive real routes with
// a queued-result db mock (see `dbResults` below).
const dbResults = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("../../src/core/database/index.js", () => {
  // A chainable, thenable query builder. Every `db.select(...)` dequeues the next
  // result; the handler awaits each query fully before the next, so FIFO order
  // matches the route's query sequence.
  // Real Promise with query-builder methods attached — a genuine thenable
  // without defining a `then` property (noThenProperty).
  const makeBuilder = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const m of ["from", "where", "orderBy", "limit"]) {
      p[m] = () => p;
    }
    return p;
  };
  const db = { select: () => makeBuilder(dbResults.queue.shift() ?? []) };
  return {
    getDb: () => db,
    schema: {
      clients: {},
      serpRankings: {},
      actionLog: {},
      pageEngagement: {},
      webVitals: {},
      llmUsage: {},
    },
  };
});
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { escapeHtml, registerDashboard } from "../../src/api/dashboard.js";

describe("escapeHtml", () => {
  it("neutralizes a script/img injection payload", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("renders null/undefined as an empty string and passes numbers through", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});

// ── GAP-008: stored-XSS protection at the actual render call sites ─────────────
// The helper is safe, but a call site can bypass it. The audit found exactly one:
// renderClientDetail passes the DB-controlled `client.name` as the <title>, which
// baseLayout interpolated unescaped. These tests render real routes with hostile
// DB values and assert no raw injection survives — including in the title.
describe("dashboard render call sites escape hostile DB values (GAP-008)", () => {
  const XSS = "<script>alert(1)</script>";
  let app: FastifyInstance;

  beforeEach(async () => {
    dbResults.queue = [];
    app = Fastify();
    await registerDashboard(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("escapes a hostile client name in the document <title> (the audited bypass)", async () => {
    // /dashboard/:id sequence: client, rankings, actions, engagement.
    dbResults.queue = [
      [
        {
          id: "c1",
          name: XSS,
          domain: "evil.com",
          industry: "roofing",
          city: "Austin",
          state: "TX",
        },
      ],
      [], // rankings
      [], // actions
      [], // engagement
    ];

    const res = await app.inject({ method: "GET", url: "/dashboard/c1" });
    expect(res.statusCode).toBe(200);
    const html = res.body;

    // The raw payload must appear NOWHERE (title, heading, or subhead).
    expect(html).not.toContain("<script>alert(1)</script>");
    // The escaped form must be present in the <title> — proving the fix, not just
    // absence of the payload elsewhere.
    expect(html).toMatch(
      /<title>[^<]*&lt;script&gt;alert\(1\)&lt;\/script&gt;[^<]*\| L9 SEO Bot<\/title>/,
    );
  });

  it("escapes hostile values in the portfolio table", async () => {
    // /dashboard sequence: clients, pendingCount, todaySpend, then per-client
    // (vitals, avgRanking, clientPending).
    dbResults.queue = [
      [{ id: "c1", name: XSS, domain: '"><img src=x onerror=alert(1)>', industry: XSS }],
      [{ count: 0 }],
      [{ total: 0 }],
      [], // latestVital
      [{ avgPos: null }],
      [{ count: 0 }],
    ];

    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes hostile action + option values on the approvals page", async () => {
    // /dashboard/approvals sequence: pending list, then per-action client lookup.
    dbResults.queue = [
      [
        {
          id: "a1",
          clientId: "c1",
          action: XSS,
          description: XSS,
          rationale: XSS,
          triggeredBy: XSS,
          module: "serp",
          riskLevel: "critical",
          reversible: false,
          aiRecommendation: XSS,
          aiConfidence: 0.9,
          options: [{ id: "a", label: XSS, description: XSS, recommended: true, confidence: 0.8 }],
        },
      ],
      [{ name: XSS, domain: XSS }], // client enrichment for a1
    ];

    const res = await app.inject({ method: "GET", url: "/dashboard/approvals" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    // The hidden option input value must be quote-safe (no attribute breakout).
    expect(res.body).not.toContain('value="<script>');
  });
});
