/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The portfolio run is the one run type with no client. Two things about it are
 * worth pinning.
 *
 * First, `client_id` must be NULL. Stamping any client on a cross-client run
 * would quietly make a portfolio statistic look like that tenant's, which is
 * both wrong and, given what the run summarizes, the wrong kind of wrong.
 *
 * Second, the counts it records have to distinguish "the floor suppressed
 * everything" from "the pipeline is broken". On a small portfolio the first is
 * much the more likely, and an operator with no way to tell them apart will go
 * looking for a bug in a working privacy control.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  intelligenceRuns: { __table: "runs", id: "runs.id" },
}));

const db = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown }[],
  updates: [] as { table: string; values: unknown }[],
  executed: [] as string[],
  coverageRows: [] as Record<string, unknown>[],
  failExecute: false,
}));

vi.mock("../../src/core/database/index.js", () => {
  const instance = {
    insert: (table: { __table: string }) => ({
      values: (values: unknown) => ({
        returning: () => {
          db.inserts.push({ table: table.__table, values });
          return Promise.resolve([{ id: "run-1" }]);
        },
      }),
    }),
    update: (table: { __table: string }) => ({
      set: (values: unknown) => ({
        where: () => {
          db.updates.push({ table: table.__table, values });
          const settled = Promise.resolve([]) as Promise<unknown> & { catch: never };
          return settled;
        },
      }),
    }),
    execute: (statement: { queryChunks?: unknown }) => {
      db.executed.push(JSON.stringify(statement?.queryChunks ?? ""));
      if (db.failExecute) return Promise.reject(new Error("relation does not exist"));
      return Promise.resolve({ rows: db.coverageRows });
    },
  };
  return { getDb: () => instance, schema: tables };
});

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  PORTFOLIO_BENCHMARK_RUN_TYPE,
  runPortfolioBenchmark,
} from "../../src/intelligence/portfolio.js";
import { BENCHMARK_K_ANONYMITY_FLOOR } from "../../src/reporting/views.js";

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.executed = [];
  db.coverageRows = [{ published: "4", suppressed: "9", periods: "2" }];
  db.failExecute = false;
});

describe("runPortfolioBenchmark", () => {
  it("records a portfolio-wide run with no client attached", () => {
    return runPortfolioBenchmark("cron").then(() => {
      const run = db.inserts[0].values as Record<string, unknown>;
      expect(run.clientId).toBeNull();
      expect(run.runType).toBe(PORTFOLIO_BENCHMARK_RUN_TYPE);
      expect(run.llmUsed).toBe(false);
    });
  });

  it("reports published and suppressed cohorts separately", async () => {
    const summary = await runPortfolioBenchmark("cron");

    expect(summary.publishedCohorts).toBe(4);
    expect(summary.suppressedCohorts).toBe(9);
    expect(summary.periods).toBe(2);
    expect(summary.anonymityFloor).toBe(BENCHMARK_K_ANONYMITY_FLOOR);
  });

  it("distinguishes an empty benchmark from a broken one", async () => {
    // Every cohort exists but sits below the floor. This is the normal state of
    // a small portfolio: publishable count 0, suppressed count high, run
    // completed. A summary that reported only "0 cohorts" would send an
    // operator hunting for a bug that is not there.
    db.coverageRows = [{ published: "0", suppressed: "11", periods: "0" }];
    const summary = await runPortfolioBenchmark("cron");

    expect(summary.publishedCohorts).toBe(0);
    expect(summary.suppressedCohorts).toBe(11);
    const completion = db.updates.find((update) => update.table === "runs");
    expect((completion?.values as { status?: string } | undefined)?.status).toBe("completed");
  });

  it("reads the coverage view rather than re-deriving cohorts", async () => {
    // A second implementation of "what counts as a cohort" is how a privacy
    // floor ends up enforced in one place and not the other.
    await runPortfolioBenchmark("cron");
    expect(db.executed.join(" ")).toContain("mv_portfolio_cohort_coverage");
  });

  it("treats a missing coverage row as zero rather than NaN", async () => {
    db.coverageRows = [];
    const summary = await runPortfolioBenchmark("cron");
    expect(summary.publishedCohorts).toBe(0);
    expect(summary.suppressedCohorts).toBe(0);
  });

  it("marks the run failed and rethrows so job_executions records it", async () => {
    // The job_failure_cluster extractor watches job_executions; swallowing this
    // would leave a benchmark silently un-recorded week after week.
    db.failExecute = true;
    await expect(runPortfolioBenchmark("cron")).rejects.toThrow(/does not exist/);

    const completion = db.updates.find((update) => update.table === "runs");
    expect((completion?.values as { status?: string } | undefined)?.status).toBe("failed");
  });
});
