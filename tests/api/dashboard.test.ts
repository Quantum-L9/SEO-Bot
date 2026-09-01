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

// The intelligence page (contract C4) reads through the reporting gateway rather
// than off the tables, so the gateway is what these tests stub. Keyed by view
// name because the page issues four queries and each panel is asserted apart.
const reporting = vi.hoisted(() => ({
  rowsByView: new Map<string, Record<string, unknown>[]>(),
  failingViews: new Set<string>(),
  requests: [] as { view: string; audience: string }[],
  refreshRows: [] as { viewName: string; ageSeconds: number; status: string }[],
  refreshThrows: false,
}));

vi.mock("../../src/reporting/query-gateway.js", () => ({
  executeReportingQuery: async (request: { view: string }, actor: { audience: string }) => {
    reporting.requests.push({ view: request.view, audience: actor.audience });
    if (reporting.failingViews.has(request.view)) {
      throw new Error(`relation "${request.view}" does not exist`);
    }
    return { rows: reporting.rowsByView.get(request.view) ?? [], rowCount: 0 };
  },
}));

vi.mock("../../src/reporting/refresh.js", () => ({
  getRefreshStatus: async () => {
    if (reporting.refreshThrows) throw new Error("refresh log unreadable");
    return reporting.refreshRows;
  },
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

// ── Contract C4: the operator surface over both planes ────────────────────────
//
// Two things carry weight here. First, the page reads through the reporting
// GATEWAY: querying the intelligence tables directly would be a second,
// unaudited read path, and the audit log exists so there is only one. Second,
// `rationale`, `hypothesis` and `learnings` are MODEL-AUTHORED free text that
// quotes evidence the bot read — they are the newest way a hostile value
// reaches an operator's session, and they are escaped like everything else.

describe("intelligence dashboard (contract C4)", () => {
  const XSS = "<script>alert(1)</script>";
  let app: FastifyInstance;

  beforeEach(async () => {
    dbResults.queue = [];
    reporting.rowsByView = new Map();
    reporting.failingViews = new Set();
    reporting.requests = [];
    reporting.refreshRows = [];
    reporting.refreshThrows = false;
    app = Fastify();
    await registerDashboard(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("reads every panel through the reporting gateway as the operator audience", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });

    expect(res.statusCode).toBe(200);
    expect(reporting.requests.map((request) => request.view).sort()).toEqual([
      "intelligence_decisions_recent",
      "intelligence_experiments_pending",
      "intelligence_opportunities_live",
      "intelligence_outcomes_measured",
    ]);
    for (const request of reporting.requests) {
      expect(request.audience).toBe("operator");
    }
  });

  it("escapes model-authored rationale, hypothesis and learnings", async () => {
    // The bot's own reasoning text is the newest untrusted render input on this
    // page: it quotes keywords and page paths straight out of client data.
    reporting.rowsByView.set("intelligence_decisions_recent", [
      { client_name: "Acme", decision: "propose_action", opportunity_title: XSS, rationale: XSS },
    ]);
    reporting.rowsByView.set("intelligence_experiments_pending", [
      { client_name: "Acme", target_metric: "serp_position", entity_id: XSS, hypothesis: XSS },
    ]);
    reporting.rowsByView.set("intelligence_outcomes_measured", [
      { client_name: "Acme", verdict: "improved", target_metric: "serp_position", learnings: XSS },
    ]);
    reporting.rowsByView.set("intelligence_opportunities_live", [
      { client_name: XSS, title: XSS, target_url: XSS, score: "42.5", status: "open" },
    ]);

    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });

    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a hostile materialized view name in the freshness line", async () => {
    reporting.refreshRows = [{ viewName: XSS, ageSeconds: 60, status: "ok" }];
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });

  it("surfaces snapshot age inline", async () => {
    // An operator reading a stale number without knowing it is stale is worse
    // served than one shown no number.
    reporting.refreshRows = [
      { viewName: "reporting.mv_portfolio_benchmarks", ageSeconds: 7200, status: "ok" },
    ];
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });
    expect(res.body).toContain("mv_portfolio_benchmarks");
    expect(res.body).toContain("120m");
  });

  it("degrades one failing panel instead of taking the page down", async () => {
    // These views arrive with migration 0005. A page that 500s wholesale
    // because one is missing takes the working panels with it.
    reporting.failingViews = new Set(["intelligence_outcomes_measured"]);
    reporting.rowsByView.set("intelligence_opportunities_live", [
      { client_name: "Acme", title: "Slow page", target_url: "/x", score: "42.5", status: "open" },
    ]);

    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Slow page");
    expect(res.body).toContain("Unavailable:");
  });

  it("renders a stale-snapshot failure without failing the page", async () => {
    reporting.refreshThrows = true;
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Snapshot freshness unavailable");
  });

  it("does not render a null metric as the word null", async () => {
    reporting.rowsByView.set("intelligence_outcomes_measured", [
      {
        client_name: "Acme",
        verdict: "inconclusive",
        target_metric: "serp_position",
        baseline: null,
        measured: null,
        learnings: null,
      },
    ]);
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });
    expect(res.body).not.toContain(">null<");
    expect(res.body).toContain("—");
  });

  it("resolves /dashboard/intelligence as the page, not as a client id", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/intelligence" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Awaiting measurement");
  });
});
