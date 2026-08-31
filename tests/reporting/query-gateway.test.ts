/* L9_META
 * layer: test
 * role: reporting_unit_test
 * status: active
 */

/**
 * The gateway's two load-bearing guarantees:
 *
 *   1. FAIL-CLOSED AUDIT. The audit row is written before the query runs, so a
 *      failed audit write means no query. Reversing that order — or catching the
 *      audit failure — would silently create an unaudited read path, which is
 *      exactly what the gateway exists to prevent.
 *
 *   2. The `$n` text that gets hashed and audited is the same statement that
 *      gets executed. `toDrizzleSql` is the join between those two, so it is
 *      round-tripped through the real Postgres dialect here rather than
 *      inspected by eye.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auditInserts: [] as Record<string, unknown>[],
  auditUpdates: [] as Record<string, unknown>[],
  executed: [] as unknown[],
  rows: [] as Record<string, unknown>[],
  insertShouldThrow: false,
  queryShouldThrow: false,
}));

vi.mock("../../src/core/database/index.js", () => {
  const tx = {
    execute: (statement: unknown) => {
      state.executed.push(statement);
      if (state.executed.length === 3) {
        if (state.queryShouldThrow) return Promise.reject(new Error("statement timeout"));
        return Promise.resolve({ rows: state.rows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          if (state.insertShouldThrow) {
            return Promise.reject(new Error("audit table unavailable"));
          }
          state.auditInserts.push(values);
          return Promise.resolve([{ id: "audit-row-1" }]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.auditUpdates.push(values);
          return Promise.resolve([]);
        },
      }),
    }),
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return {
    getDb: () => db,
    schema: {
      reportingQueryAuditLog: { id: "audit.id" },
      reportingRefreshLog: { viewName: "refresh.view_name", refreshedAt: "refresh.refreshed_at" },
    },
  };
});

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { compileReportingQuery } from "../../src/reporting/query-compiler.js";
import {
  executeReportingQuery,
  type ReportingActor,
  toDrizzleSql,
} from "../../src/reporting/query-gateway.js";

const OPERATOR: ReportingActor = {
  id: "operator",
  type: "human",
  surface: "api:reporting",
  audience: "operator",
};
const AGENT: ReportingActor = {
  id: "reporting-agent",
  type: "agent",
  surface: "api:reporting",
  audience: "agent",
};

beforeEach(() => {
  state.auditInserts = [];
  state.auditUpdates = [];
  state.executed = [];
  state.rows = [];
  state.insertShouldThrow = false;
  state.queryShouldThrow = false;
});

describe("toDrizzleSql", () => {
  const dialect = new PgDialect();

  it("round-trips the compiled statement and its parameters through the dialect", () => {
    const compiled = compileReportingQuery(
      {
        view: "keyword_drops_7d",
        filters: { client_id: "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04", min_delta: 9 },
        limit: 10,
      },
      "operator",
    );
    const query = dialect.sqlToQuery(toDrizzleSql(compiled));

    expect(query.sql).toBe(compiled.text);
    expect(query.params).toEqual(compiled.params);
  });

  it("round-trips a statement with no filters", () => {
    const compiled = compileReportingQuery({ view: "pending_approvals" }, "operator");
    const query = dialect.sqlToQuery(toDrizzleSql(compiled));
    expect(query.sql).toBe(compiled.text);
    expect(query.params).toEqual(compiled.params);
  });

  it("round-trips a multi-value IN predicate without collapsing placeholders", () => {
    const compiled = compileReportingQuery(
      { view: "page_experience_risks", filters: { risk_level: ["critical", "high"] } },
      "agent",
    );
    const query = dialect.sqlToQuery(toDrizzleSql(compiled));
    expect(query.sql).toBe(compiled.text);
    expect(query.params).toEqual(["critical", "high", compiled.limit]);
  });

  it("refuses a compiled query whose placeholders outrun its parameters", () => {
    const broken = {
      text: "SELECT a FROM x WHERE b = $1 AND c = $2",
      params: [1],
      columns: ["a"],
      view: "x",
      relation: '"reporting"."x"',
      orderBy: "a",
      limit: 1,
      appliedFilters: {},
      sqlHash: "deadbeef",
    };
    expect(() => toDrizzleSql(broken)).toThrow(/references \$2 but only 1 parameter/);
  });
});

describe("executeReportingQuery — audit is fail-closed", () => {
  it("writes the audit row before executing anything", async () => {
    await executeReportingQuery({ view: "pending_approvals" }, OPERATOR);

    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toMatchObject({
      actor: "operator",
      actorType: "human",
      surface: "api:reporting",
      queryName: "pending_approvals",
      status: "started",
    });
    expect(state.auditInserts[0].sqlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT run the query when the audit row cannot be written", async () => {
    state.insertShouldThrow = true;

    await expect(executeReportingQuery({ view: "pending_approvals" }, OPERATOR)).rejects.toThrow(
      /audit table unavailable/,
    );
    // Not even the SET LOCAL statements ran.
    expect(state.executed).toHaveLength(0);
  });

  it("records the outcome on the audit row after a successful read", async () => {
    state.rows = [{ id: "a" }, { id: "b" }];
    const result = await executeReportingQuery({ view: "pending_approvals" }, OPERATOR);

    expect(result.rowCount).toBe(2);
    expect(state.auditUpdates).toHaveLength(1);
    expect(state.auditUpdates[0]).toMatchObject({ status: "ok", rowCount: 2 });
  });

  it("records a failed query on the audit row and rethrows", async () => {
    state.queryShouldThrow = true;

    await expect(executeReportingQuery({ view: "pending_approvals" }, OPERATOR)).rejects.toThrow(
      /statement timeout/,
    );
    expect(state.auditUpdates).toHaveLength(1);
    expect(state.auditUpdates[0]).toMatchObject({ status: "error" });
    expect(String(state.auditUpdates[0].error)).toContain("statement timeout");
  });

  it("audits only validated filter values, never raw caller input", async () => {
    await executeReportingQuery(
      {
        view: "page_experience_risks",
        filters: { risk_level: ["critical", "critical", "high"] },
      },
      OPERATOR,
    );
    // Deduplicated and validated — the audit reflects what actually ran.
    expect(state.auditInserts[0].parameters).toEqual({ risk_level: ["critical", "high"] });
  });

  it("never reaches the audit table for a request the registry rejects", async () => {
    await expect(executeReportingQuery({ view: "nope" }, OPERATOR)).rejects.toThrow(/Unknown view/);
    expect(state.auditInserts).toHaveLength(0);
  });
});

describe("executeReportingQuery — transaction guards", () => {
  const dialect = new PgDialect();

  it("sets a read-only transaction and a statement timeout before the query", async () => {
    await executeReportingQuery({ view: "pending_approvals" }, OPERATOR);

    const statements = state.executed.map(
      (statement) => dialect.sqlToQuery(statement as never).sql,
    );
    expect(statements[0]).toBe("SET LOCAL statement_timeout = 15000");
    expect(statements[1]).toBe("SET LOCAL transaction_read_only = on");
    expect(statements[2]).toContain('FROM "reporting"."pending_approvals"');
  });

  it("gives the agent audience a tighter statement timeout than the operator", async () => {
    await executeReportingQuery({ view: "llm_spend_monthly" }, AGENT);
    const first = dialect.sqlToQuery(state.executed[0] as never).sql;
    expect(first).toBe("SET LOCAL statement_timeout = 5000");
  });
});

describe("executeReportingQuery — result shape", () => {
  it("reports truncated when the page is exactly full", async () => {
    state.rows = Array.from({ length: 3 }, (_, index) => ({ id: index }));
    const result = await executeReportingQuery({ view: "pending_approvals", limit: 3 }, OPERATOR);
    expect(result.truncated).toBe(true);
  });

  it("reports not truncated when fewer rows than the limit came back", async () => {
    state.rows = [{ id: 1 }];
    const result = await executeReportingQuery({ view: "pending_approvals", limit: 3 }, OPERATOR);
    expect(result.truncated).toBe(false);
  });

  it("returns the audience projection as the column contract", async () => {
    const result = await executeReportingQuery({ view: "llm_spend_monthly" }, AGENT);
    expect(result.columns).not.toContain("client_name");
    expect(result.columns).toContain("cost_usd");
  });
});
