/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

/**
 * The reporting surface's security property is that the CREDENTIAL, not the
 * request, chooses the audience — and therefore the column projection.
 *
 * A request body that could pick its own audience, or an agent key that
 * resolved to the operator audience, would hand client names, domains and
 * contact PII to an LLM tool. Those are the cases driven here through the real
 * security hook and the real route.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR_KEY = "operator-secret-key";
const AGENT_KEY = "agent-secret-key";

const configState = vi.hoisted(() => ({
  OPERATOR_API_KEY: "operator-secret-key" as string | undefined,
  REPORTING_AGENT_API_KEY: "agent-secret-key" as string | undefined,
}));

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => configState,
  loadConfig: () => configState,
}));

const gatewayState = vi.hoisted(() => ({
  calls: [] as { request: unknown; actor: unknown }[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock("../../src/reporting/query-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/reporting/query-gateway.js")>();
  const { compileReportingQuery } = await import("../../src/reporting/query-compiler.js");
  return {
    ...actual,
    // Compile for real (so registry rejections still surface as 400s) but do
    // not touch a database.
    executeReportingQuery: async (request: never, actor: never) => {
      gatewayState.calls.push({ request, actor });
      const compiled = compileReportingQuery(request, (actor as { audience: never }).audience);
      return {
        view: compiled.view,
        columns: compiled.columns,
        rows: gatewayState.rows,
        rowCount: gatewayState.rows.length,
        truncated: false,
        limit: compiled.limit,
        durationMs: 1,
        auditId: "audit-1",
      };
    },
  };
});

vi.mock("../../src/reporting/refresh.js", () => ({
  getRefreshStatus: async () => [
    {
      viewName: "reporting.mv_llm_spend_monthly",
      refreshedAt: new Date("2026-08-31T00:00:00Z"),
      durationMs: 120,
      status: "ok",
      error: null,
      ageSeconds: 600,
    },
  ],
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { registerReportingRoutes } from "../../src/api/reporting.js";
import {
  _resetRateLimiter,
  isStrictRateLimited,
  registerApiSecurity,
} from "../../src/api/security.js";

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  registerApiSecurity(instance);
  await registerReportingRoutes(instance);
  await instance.ready();
  return instance;
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

beforeEach(async () => {
  _resetRateLimiter();
  gatewayState.calls = [];
  gatewayState.rows = [];
  configState.OPERATOR_API_KEY = OPERATOR_KEY;
  configState.REPORTING_AGENT_API_KEY = AGENT_KEY;
  app = await build();
});

afterEach(async () => {
  await app.close();
});

describe("reporting surface authentication", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/reporting/views" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown credential", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer("not-a-key"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects the machine build-intelligence key on the reporting surface", async () => {
    // Least privilege: the Website-Bot machine credential is not a reporting key.
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer("seo-bot-machine-key"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("locks the surface when neither reporting key is configured", async () => {
    configState.OPERATOR_API_KEY = undefined;
    configState.REPORTING_AGENT_API_KEY = undefined;
    await app.close();
    app = await build();

    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(OPERATOR_KEY),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "authentication not configured" });
  });

  it("gives agents no access at all when the agent key is unset", async () => {
    // The agent surface is opt-in; unset must mean closed, not open.
    configState.REPORTING_AGENT_API_KEY = undefined;
    await app.close();
    app = await build();

    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(AGENT_KEY),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a Basic password as well as a Bearer token", async () => {
    const basic = Buffer.from(`operator:${OPERATOR_KEY}`).toString("base64");
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: { authorization: `Basic ${basic}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("the credential chooses the audience", () => {
  it("resolves the operator key to the operator audience", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(OPERATOR_KEY),
    });
    expect(res.json().audience).toBe("operator");
  });

  it("resolves the agent key to the agent audience", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(AGENT_KEY),
    });
    expect(res.json().audience).toBe("agent");
  });

  it("ignores an audience the request body tries to claim", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(AGENT_KEY),
      payload: { view: "llm_spend_monthly", audience: "operator", actor: { audience: "operator" } },
    });
    expect(res.statusCode).toBe(200);
    expect(gatewayState.calls[0].actor).toMatchObject({ audience: "agent", type: "agent" });
    expect(res.json().columns).not.toContain("client_name");
  });

  it("refuses an operator-only view to an agent credential", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(AGENT_KEY),
      payload: { view: "link_prospects_uncontacted" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not available to the agent audience/);
  });

  it("serves the same view with a narrower projection to an agent", async () => {
    const operator = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(OPERATOR_KEY),
      payload: { view: "llm_spend_monthly" },
    });
    const agent = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(AGENT_KEY),
      payload: { view: "llm_spend_monthly" },
    });

    expect(operator.json().columns).toContain("client_name");
    expect(agent.json().columns).not.toContain("client_name");
    expect(agent.json().columns).not.toContain("domain");
  });
});

describe("GET /api/reporting/views", () => {
  it("lists only what the calling audience can reach", async () => {
    const agent = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(AGENT_KEY),
    });
    const names = agent.json().views.map((view: { name: string }) => view.name);
    expect(names).not.toContain("link_prospects_uncontacted");
    expect(names).not.toContain("pending_approvals");
    expect(names).toContain("llm_spend_monthly");
  });

  it("publishes the filter and ordering contract so callers need no schema dump", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(OPERATOR_KEY),
    });
    const view = res
      .json()
      .views.find((entry: { name: string }) => entry.name === "keyword_drops_7d");
    expect(view.filters.min_delta).toMatchObject({ kind: "int", min: 5, max: 200 });
    expect(view.orderBy).toContain("delta_desc");
    expect(view.maxLimit).toBeGreaterThan(0);
  });

  it("never lists a client-identifying column for the agent audience", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/views",
      headers: bearer(AGENT_KEY),
    });
    for (const view of res.json().views) {
      expect(view.columns).not.toContain("client_name");
      expect(view.columns).not.toContain("domain");
      expect(view.columns).not.toContain("contact_email");
    }
  });
});

describe("POST /api/reporting/query", () => {
  it("returns rows with the audience column contract", async () => {
    gatewayState.rows = [{ month: "2026-08-01", cost_usd: "12.4000" }];
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(AGENT_KEY),
      payload: { view: "llm_spend_monthly", limit: 5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ view: "llm_spend_monthly", rowCount: 1, limit: 5 });
  });

  it("answers a registry rejection with 400 and a usable message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(OPERATOR_KEY),
      payload: { view: "keyword_drops_7d", filters: { tenant: "acme" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown filter.*Available:/s);
  });

  it("rejects a non-object filters value rather than ignoring it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(OPERATOR_KEY),
      payload: { view: "keyword_drops_7d", filters: ["client_id"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("filters must be an object");
  });

  it("rejects a non-numeric limit rather than silently defaulting", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(OPERATOR_KEY),
      payload: { view: "keyword_drops_7d", limit: "50" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("limit must be a number");
  });

  it("passes a stable actor identity to the gateway for the audit row", async () => {
    await app.inject({
      method: "POST",
      url: "/api/reporting/query",
      headers: bearer(OPERATOR_KEY),
      payload: { view: "pending_approvals" },
    });
    expect(gatewayState.calls[0].actor).toEqual({
      id: "operator",
      type: "human",
      surface: "api:reporting",
      audience: "operator",
    });
  });
});

describe("rate limiting", () => {
  it("caps the expensive query endpoint harder than the cheap listing ones", async () => {
    // Each query holds a connection for up to the audience statement timeout;
    // the default 120/min cap would let one caller outspend the wall clock.
    expect(isStrictRateLimited("/api/reporting/query")).toBe(true);
    expect(isStrictRateLimited("/api/reporting/views")).toBe(false);
    expect(isStrictRateLimited("/api/reporting/refresh-status")).toBe(false);
  });

  it("returns 429 once the strict cap is exceeded", async () => {
    let last = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/reporting/query",
        headers: bearer(OPERATOR_KEY),
        payload: { view: "pending_approvals" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("GET /api/reporting/refresh-status", () => {
  it("reports how stale each materialized snapshot is", async () => {
    // An answer drawn from a stale snapshot is worse than no answer, so age is
    // part of the contract rather than something the caller has to infer.
    const res = await app.inject({
      method: "GET",
      url: "/api/reporting/refresh-status",
      headers: bearer(OPERATOR_KEY),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().views[0]).toMatchObject({
      viewName: "reporting.mv_llm_spend_monthly",
      status: "ok",
      ageSeconds: 600,
    });
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/reporting/refresh-status" });
    expect(res.statusCode).toBe(401);
  });
});
