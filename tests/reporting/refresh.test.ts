/* L9_META
 * layer: test
 * role: reporting_unit_test
 * status: active
 */

/**
 * Refresh is scheduler-owned for a reason: it holds locks and burns I/O, so an
 * ad-hoc caller triggering it turns the reporting plane into an availability
 * problem for the bot it reports on.
 *
 * The behavior worth pinning is what happens when ONE view fails: the rest must
 * still refresh, and `refresh_log` must say honestly which snapshot is stale.
 * An all-or-nothing abort would leave the operator unable to tell.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executed: [] as string[],
  logged: [] as Record<string, unknown>[],
  failFor: new Set<string>(),
}));

vi.mock("../../src/core/database/index.js", () => {
  const db = {
    execute: (statement: { queryChunks?: unknown[] }) => {
      // sql.raw puts the literal text in the first chunk's `value` array.
      const text = JSON.stringify(statement);
      state.executed.push(text);
      for (const viewName of state.failFor) {
        if (text.includes(viewName)) return Promise.reject(new Error(`lock timeout ${viewName}`));
      }
      return Promise.resolve({ rows: [] });
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          state.logged.push(values);
          return Promise.resolve([]);
        },
      }),
    }),
    select: () => {
      const p = Promise.resolve([]) as Promise<unknown> & Record<string, () => unknown>;
      for (const method of ["from", "orderBy"]) p[method] = () => p;
      return p;
    },
  };
  return {
    getDb: () => db,
    schema: { reportingRefreshLog: { viewName: "view_name", refreshedAt: "refreshed_at" } },
  };
});

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { MATERIALIZED_VIEWS, refreshMaterializedViews } from "../../src/reporting/refresh.js";

beforeEach(() => {
  state.executed = [];
  state.logged = [];
  state.failFor = new Set();
});

describe("refreshMaterializedViews", () => {
  it("refreshes every listed view CONCURRENTLY", async () => {
    const outcomes = await refreshMaterializedViews();

    expect(outcomes).toHaveLength(MATERIALIZED_VIEWS.length);
    expect(outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
    for (const statement of state.executed) {
      expect(statement).toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY");
    }
  });

  it("records each refresh in the log with its duration", async () => {
    await refreshMaterializedViews();
    expect(state.logged).toHaveLength(MATERIALIZED_VIEWS.length);
    for (const entry of state.logged) {
      expect(entry.status).toBe("ok");
      expect(typeof entry.durationMs).toBe("number");
    }
  });

  it("continues past a failing view instead of aborting the pass", async () => {
    state.failFor = new Set(["mv_llm_spend_monthly"]);
    const outcomes = await refreshMaterializedViews();

    const failed = outcomes.filter((outcome) => outcome.status === "error");
    const ok = outcomes.filter((outcome) => outcome.status === "ok");
    expect(failed).toHaveLength(1);
    expect(ok).toHaveLength(MATERIALIZED_VIEWS.length - 1);
    expect(failed[0].error).toContain("lock timeout");
  });

  it("records the failure so the operator can see which snapshot is stale", async () => {
    state.failFor = new Set(["mv_weekly_keyword_movements"]);
    await refreshMaterializedViews();

    const failureEntry = state.logged.find((entry) => entry.status === "error");
    expect(failureEntry?.viewName).toBe("reporting.mv_weekly_keyword_movements");
    expect(String(failureEntry?.error)).toContain("lock timeout");
  });

  it("refuses an unsafe view name before it reaches the database", async () => {
    await expect(refreshMaterializedViews(["reporting.mv_x; DROP TABLE clients"])).rejects.toThrow(
      /unsafe materialized view/,
    );
    expect(state.executed).toHaveLength(0);
  });
});
