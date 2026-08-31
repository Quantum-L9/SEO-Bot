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
import { REPORTING_VIEWS } from "../../src/reporting/views.js";

const MIGRATION = readFileSync(
  path.join(process.cwd(), "drizzle", "0002_reporting_plane.sql"),
  "utf8",
);

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

describe("reporting registry matches migration 0002", () => {
  const created = createdRelations(MIGRATION);

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
    const sql = executableSql(MIGRATION);
    expect(sql).not.toMatch(/posthog_api_key/i);
    expect(sql).not.toMatch(/posthog_project_id/i);
  });

  it("marks the client dimension views as security barriers", () => {
    const barrierViews = MIGRATION.match(/WITH \(security_barrier = true\)/g) ?? [];
    expect(barrierViews.length).toBeGreaterThanOrEqual(2);
  });

  it("creates no role and embeds no password (provisioning is a separate script)", () => {
    const sql = executableSql(MIGRATION);
    expect(sql).not.toMatch(/CREATE\s+ROLE/i);
    expect(sql).not.toMatch(/PASSWORD/i);
    expect(sql).not.toMatch(/\bGRANT\b/i);
  });

  it("scopes the agent client view to a hashed reference, not the raw name", () => {
    expect(MIGRATION).toContain("encode(digest(c.id::text, 'sha256'), 'hex') AS client_ref");
  });
});

describe("materialized refresh list", () => {
  const uniqueTargets = uniqueIndexTargets(MIGRATION);

  it("only lists views the migration created", () => {
    const created = createdRelations(MIGRATION);
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

    // drizzle decides what is pending by comparing folderMillis; a non-increasing
    // `when` makes a migration silently un-appliable.
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when);
      expect(journal.entries[index].idx).toBe(journal.entries[index - 1].idx + 1);
    }
  });
});
