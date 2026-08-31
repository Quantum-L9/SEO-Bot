/* L9_META
 * layer: test
 * role: reporting_contract_test
 * status: active
 */

/**
 * The registry, the refresh list, and the migration have to agree.
 *
 * Nothing else catches a drift between them: a registry entry naming a relation
 * the migration never creates compiles, type-checks, passes every unit test, and
 * then 42P01s in production. Likewise a materialized view added to the refresh
 * list without a UNIQUE index fails only at REFRESH ... CONCURRENTLY time, hours
 * after deploy.
 *
 * So this reads the shipped migration SQL as the source of truth and checks the
 * TypeScript against it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// refresh.ts reaches the db module at import, which loads config. This suite
// reads SQL files and module constants only — inert stubs are enough.
vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({}),
  schema: { reportingRefreshLog: {} },
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { MATERIALIZED_VIEWS, quoteMaterializedView } from "../../src/reporting/refresh.js";
import { BENCHMARK_K_ANONYMITY_FLOOR, REPORTING_VIEWS } from "../../src/reporting/views.js";

function migration(file: string): string {
  return readFileSync(path.join(process.cwd(), "drizzle", file), "utf8");
}

const MIGRATION = migration("0002_reporting_plane.sql");
const BENCHMARKS = migration("0004_portfolio_benchmarks.sql");

/**
 * Every migration that adds to the `reporting` schema. The registry does not
 * know or care which file created a relation, so the parity checks must read
 * them all — pinning them to 0002 alone would have made every later reporting
 * migration invisible to the very test that exists to catch drift.
 */
const REPORTING_MIGRATIONS = [MIGRATION, BENCHMARKS].join("\n");

/**
 * The migration with `--` line comments stripped. Assertions about what the
 * migration DOES must read executable SQL: the header comment legitimately says
 * "must not embed role passwords", and a test that flagged that sentence would
 * be testing prose.
 */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** Relations the migration actually creates in the reporting schema. */
function createdRelations(sql: string): Set<string> {
  const relations = new Set<string>();
  const pattern =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"reporting"\."([a-z0-9_]+)"/gi;
  for (const match of sql.matchAll(pattern)) relations.add(match[1]);
  return relations;
}

function uniqueIndexTargets(sql: string): Set<string> {
  const targets = new Set<string>();
  const pattern =
    /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"[a-z0-9_]+"\s*\n?\s*ON\s+"reporting"\."([a-z0-9_]+)"/gi;
  for (const match of sql.matchAll(pattern)) targets.add(match[1]);
  return targets;
}

describe("reporting registry matches its migrations", () => {
  const created = createdRelations(REPORTING_MIGRATIONS);

  it("creates every relation the registry references", () => {
    for (const view of REPORTING_VIEWS) {
      const relationName = view.relation.replace(/"/g, "").split(".")[1];
      expect(created.has(relationName), `${view.name} → ${view.relation}`).toBe(true);
    }
  });

  it("creates the reporting schema and the path-normalizing function", () => {
    expect(MIGRATION).toContain('CREATE SCHEMA IF NOT EXISTS "reporting"');
    expect(MIGRATION).toContain('"reporting"."path_from_url"');
  });

  it("never selects a PostHog credential into the reporting schema", () => {
    // The clients table holds posthog_api_key; a view that projected it would
    // hand a credential to every reporting consumer at once.
    const sql = executableSql(REPORTING_MIGRATIONS);
    expect(sql).not.toMatch(/posthog_api_key/i);
    expect(sql).not.toMatch(/posthog_project_id/i);
  });

  it("marks the client dimension views as security barriers", () => {
    const barrierViews = MIGRATION.match(/WITH \(security_barrier = true\)/g) ?? [];
    expect(barrierViews.length).toBeGreaterThanOrEqual(2);
  });

  it("creates no role and embeds no password (provisioning is a separate script)", () => {
    const sql = executableSql(REPORTING_MIGRATIONS);
    expect(sql).not.toMatch(/CREATE\s+ROLE/i);
    expect(sql).not.toMatch(/PASSWORD/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
  });

  it("scopes the agent client view to a hashed reference, not the raw name", () => {
    expect(MIGRATION).toContain("encode(digest(c.id::text, 'sha256'), 'hex') AS client_ref");
  });
});

describe("materialized refresh list", () => {
  const uniqueTargets = uniqueIndexTargets(REPORTING_MIGRATIONS);

  it("only lists views the migration created", () => {
    const created = createdRelations(REPORTING_MIGRATIONS);
    for (const viewName of MATERIALIZED_VIEWS) {
      const relationName = viewName.split(".")[1];
      expect(created.has(relationName), viewName).toBe(true);
    }
  });

  it("only lists views that carry a UNIQUE index, as CONCURRENTLY requires", () => {
    for (const viewName of MATERIALIZED_VIEWS) {
      const relationName = viewName.split(".")[1];
      expect(uniqueTargets.has(relationName), `${viewName} needs a UNIQUE index`).toBe(true);
    }
  });

  it("quotes a schema-qualified name for DDL", () => {
    expect(quoteMaterializedView("reporting.mv_llm_spend_monthly")).toBe(
      '"reporting"."mv_llm_spend_monthly"',
    );
  });

  it("refuses a name that is not a bare schema.relation identifier", () => {
    for (const hostile of [
      "reporting.mv_x; DROP TABLE clients",
      'reporting."mv_x"',
      "mv_x",
      "reporting.mv_x WITH DATA",
    ]) {
      expect(() => quoteMaterializedView(hostile), hostile).toThrow(/unsafe materialized view/);
    }
  });
});

describe("migration journal", () => {
  it("registers both new migrations with strictly increasing timestamps", () => {
    const journal = JSON.parse(
      readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };

    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain("0002_reporting_plane");
    expect(tags).toContain("0003_intelligence_plane");
    expect(tags).toContain("0004_portfolio_benchmarks");

    // drizzle decides what is pending by comparing folderMillis; a non-increasing
    // `when` makes a migration silently un-appliable.
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when);
      expect(journal.entries[index].idx).toBe(journal.entries[index - 1].idx + 1);
    }
  });
});

describe("portfolio benchmarks: the k-anonymity floor", () => {
  /**
   * The published benchmark view, without its comments. Assertions about what
   * the SQL DOES must read executable SQL — the header legitimately discusses
   * two- and three-client cohorts in prose, and a test that matched those
   * sentences would be testing the explanation rather than the control.
   */
  const benchmarkView = (() => {
    const executable = executableSql(BENCHMARKS);
    const start = executable.indexOf('CREATE OR REPLACE VIEW "reporting"."portfolio_benchmarks"');
    const end = executable.indexOf("--> statement-breakpoint", start);
    expect(start).toBeGreaterThan(-1);
    return executable.slice(start, end);
  })();

  /** Every `>= N` guard in the view. Each one is a disclosure control. */
  const guards = [...benchmarkView.matchAll(/>=\s*(\d+)/g)].map((match) => Number(match[1]));

  it("guards every published statistic at or above the declared floor", () => {
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      expect(guard).toBeGreaterThanOrEqual(BENCHMARK_K_ANONYMITY_FLOOR);
    }
  });

  it("guards the cohort AND each metric independently", () => {
    // One row-level HAVING plus a guard for each of the four metrics' count and
    // three percentiles. The per-metric guards are the ones easy to omit: a
    // cohort can hold five clients while only two have vitals data, and an LCP
    // median over those two would be a two-client disclosure published under a
    // five-client cohort label.
    expect(benchmarkView).toMatch(/HAVING\s+count\(DISTINCT client_id\)\s*>=\s*5/);
    for (const metric of ["avg_position", "avg_lcp", "avg_exit_rate", "citation_rate_pct"]) {
      const metricGuards = [
        ...benchmarkView.matchAll(new RegExp(`count\\(${metric}\\)\\s*>=\\s*(\\d+)`, "g")),
      ];
      // count + p25 + p50 + p75.
      expect(metricGuards.length, metric).toBe(4);
      for (const [, value] of metricGuards) {
        expect(Number(value), metric).toBeGreaterThanOrEqual(BENCHMARK_K_ANONYMITY_FLOOR);
      }
    }
  });

  it("publishes no client identity in the benchmark or its coverage view", () => {
    for (const relation of ["portfolio_benchmarks", "portfolio_cohort_coverage"]) {
      const projection = REPORTING_VIEWS.find((view) => view.name === relation);
      expect(projection, relation).toBeDefined();
      for (const audience of ["operator", "agent"] as const) {
        const columns = projection?.projections[audience] ?? [];
        expect(columns.length, `${relation}.${audience}`).toBeGreaterThan(0);
        for (const forbidden of ["client_id", "client_name", "name", "domain", "client_ref"]) {
          expect(columns, `${relation}.${audience}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("keeps the per-client rollup out of the registry entirely", () => {
    // client_period_metrics is the building block the benchmark aggregates
    // over, and it is per-client by construction. Unregistered means
    // unreachable through the query gateway — there is no audience for it.
    expect(createdRelations(BENCHMARKS)).toContain("client_period_metrics");
    expect(REPORTING_VIEWS.map((view) => view.name)).not.toContain("client_period_metrics");
    for (const view of REPORTING_VIEWS) {
      expect(view.relation).not.toContain("client_period_metrics");
    }
  });

  it("never publishes the size of a suppressed cohort", () => {
    // A coverage row says a cohort exists and is below the floor. Saying HOW
    // far below would hand back the small-n fact the floor exists to withhold.
    const coverageStart = executableSql(BENCHMARKS).indexOf(
      'CREATE OR REPLACE VIEW "reporting"."portfolio_cohort_coverage"',
    );
    const coverage = executableSql(BENCHMARKS).slice(coverageStart);
    expect(coverage).toMatch(/CASE WHEN count\(DISTINCT client_id\) >= 5 THEN/);
  });

  it("materializes both benchmark views with the UNIQUE index CONCURRENTLY needs", () => {
    const uniqueTargets = uniqueIndexTargets(BENCHMARKS);
    expect(uniqueTargets).toContain("mv_portfolio_benchmarks");
    expect(uniqueTargets).toContain("mv_portfolio_cohort_coverage");
    expect(MATERIALIZED_VIEWS).toContain("reporting.mv_portfolio_benchmarks");
    expect(MATERIALIZED_VIEWS).toContain("reporting.mv_portfolio_cohort_coverage");
  });

  it("normalizes every cohort dimension so the UNIQUE index has no NULLs", () => {
    // NULLs compare as distinct in a btree, which leaves REFRESH ...
    // CONCURRENTLY unable to identify the row it needs to diff.
    for (const dimension of ["industry", "country", "state"]) {
      expect(BENCHMARKS).toContain(`'unknown') AS ${dimension}`);
    }
  });
});
