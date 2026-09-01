/* L9_META
 * layer: test
 * role: script_contract_test
 * status: active
 */

/**
 * Testing contract §13 — the post-run SQL pack, checked without a database.
 *
 * A verification pack is a peculiar artifact: it only ever runs against staging
 * and production, so the ordinary way to find out it is wrong is to run it
 * during an incident and get "0 violations" from a query against a table that
 * does not exist. Every failure mode below is one of those.
 *
 *   - a relation or column that the migrations never created
 *   - a query that could write
 *   - an "expected count" the reader has to interpret
 *   - a vocabulary list that drifted from the code it mirrors
 *
 * So the migrations are the fixture. The pack is checked against the schema as
 * shipped, in the same repository, at the same commit.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/config.js", () => ({ getConfig: () => ({}) }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/database/index.js", () => ({ getDb: () => ({}), schema: {} }));

import {
  assertReadOnly,
  formatReport,
  hasFindings,
  INVARIANTS,
  type Invariant,
  runInvariants,
} from "../../scripts/intelligence/verify-invariants.js";
import { PLAN_TEMPLATES } from "../../src/intelligence/action-planner.js";

const MIGRATIONS = readdirSync(join(process.cwd(), "drizzle"))
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(join(process.cwd(), "drizzle", name), "utf8"))
  .join("\n");

/** Relations named after FROM or JOIN, schema-qualified or not. */
function relationsIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+(?:\.[a-z_]+)?)/gi)]
    .map((match) => match[1].toLowerCase())
    .filter((name) => name !== "group" && name !== "order");
}

describe("the pack is read-only", () => {
  it("contains no statement that could write", () => {
    // This runs against production. A verification tool that can write is a
    // verification tool that can be the incident.
    for (const invariant of INVARIANTS) {
      expect(() => assertReadOnly(invariant), invariant.id).not.toThrow();
    }
  });

  it("rejects a write, so the guard is real rather than decorative", () => {
    const hostile: Invariant = {
      id: "TEST-01",
      title: "t",
      meaning: "m",
      sql: "DELETE FROM intelligence_runs WHERE true",
    };
    expect(() => assertReadOnly(hostile)).toThrow(/read-only/);
  });

  it("rejects a second statement smuggled in behind a semicolon", () => {
    const stacked: Invariant = {
      id: "TEST-02",
      title: "t",
      meaning: "m",
      // No write keyword, so this isolates the separator rule rather than
      // passing for the other check's reason.
      sql: "SELECT 1; SELECT id FROM action_log",
    };
    expect(() => assertReadOnly(stacked)).toThrow(/one query per invariant/);
  });

  it("does not mistake a keyword inside a string literal for a write", () => {
    // The plane's own action vocabulary contains `faq_content_add`; a naive
    // keyword scan that reads inside quotes would reject its own pack.
    const literal: Invariant = {
      id: "TEST-03",
      title: "t",
      meaning: "m",
      sql: "SELECT id FROM action_log WHERE action IN ('faq_content_add', 'create_thing')",
    };
    expect(() => assertReadOnly(literal)).not.toThrow();
  });
});

describe("every invariant queries relations the migrations actually create", () => {
  it("names no unknown relation", () => {
    const unknown: string[] = [];
    for (const invariant of INVARIANTS) {
      for (const relation of relationsIn(invariant.sql)) {
        const bare = relation.includes(".") ? relation.split(".")[1] : relation;
        const schema = relation.includes(".") ? relation.split(".")[0] : null;
        // Migrations quote identifiers, and schema-qualified names appear as
        // "reporting"."thing". Match either spelling.
        const patterns = [`"${bare}"`, schema ? `"${schema}"."${bare}"` : "", ` ${bare} `].filter(
          Boolean,
        );
        if (!patterns.some((pattern) => MIGRATIONS.includes(pattern))) {
          unknown.push(`${invariant.id}: ${relation}`);
        }
      }
    }
    expect(
      unknown,
      "A query against a relation that does not exist returns an ERROR, and an operator running " +
        "the pack during an incident reads that as noise. Fix the query or add the migration.",
    ).toEqual([]);
  });

  it("finds relations at all — the extractor is not silently matching nothing", () => {
    // Guards the guard: a broken regex would make the test above pass over an
    // empty list forever.
    const all = INVARIANTS.flatMap((invariant) => relationsIn(invariant.sql));
    expect(all).toContain("intelligence_runs");
    expect(all).toContain("action_log");
    expect(all).toContain("reporting.portfolio_benchmarks");
    expect(all.length).toBeGreaterThan(INVARIANTS.length);
  });

  it("references only columns the migrations declare", () => {
    // Column-level, because the relation existing is the easy half. Checked as a
    // spot list of the columns whose absence would silently return zero rows.
    const requiredColumns: [string, string[]][] = [
      ["intelligence_runs", ["status", "started_at", "error", "run_type"]],
      ["intelligence_opportunities", ["status", "fingerprint", "opportunity_type", "updated_at"]],
      ["intelligence_experiments", ["action_outcome_id", "decision_id", "baseline_start"]],
      ["intelligence_signals", ["run_id", "client_id"]],
      ["action_log", ["module", "action", "status", "risk_level"]],
      ["job_executions", ["job_name", "started_at"]],
      ["llm_usage", ["module", "purpose", "tier", "cost"]],
    ];
    for (const [table, columns] of requiredColumns) {
      const start = MIGRATIONS.indexOf(`"${table}" (`);
      expect(start, `${table} is not created by any migration`).toBeGreaterThan(-1);
      const body = MIGRATIONS.slice(start, MIGRATIONS.indexOf(");", start));
      for (const column of columns) {
        expect(body.includes(`"${column}"`), `${table}.${column}`).toBe(true);
      }
    }
  });

  it("uses the reporting view's real column names", () => {
    // The benchmark view exposes `cohort_size` and `period`; an earlier draft of
    // this pack asked for `client_count` and `month`, which would have errored
    // on every run while reading like a clean privacy check.
    const benchmark = INVARIANTS.filter((invariant) =>
      invariant.sql.includes("portfolio_benchmarks"),
    );
    expect(benchmark.length).toBeGreaterThan(0);
    for (const invariant of benchmark) {
      expect(invariant.sql, invariant.id).toMatch(/cohort_size|position_clients|lcp_clients/);
      expect(invariant.sql, invariant.id).not.toContain("client_count");
    }
  });
});

describe("the action vocabulary tracks the plan templates", () => {
  it("lists exactly the actions the plane can propose", () => {
    // INTEL-04 asks whether anything outside the vocabulary was auto-executed.
    // If the vocabulary drifts BEHIND the templates, a legitimate action reads
    // as a violation; if it drifts AHEAD, a removed action stops being caught.
    const templateActions = [
      ...new Set(
        Object.values(PLAN_TEMPLATES)
          .filter((template): template is NonNullable<typeof template> => Boolean(template))
          .map((template) => template.action),
      ),
    ].sort();

    const intel04 = INVARIANTS.find((invariant) => invariant.id === "INTEL-04");
    // Only the NOT IN list — the same query also compares module and status
    // against literals, and sweeping up every quoted string would compare the
    // vocabulary against those too.
    const notIn = intel04?.sql.match(/NOT IN \(([^)]*)\)/);
    expect(notIn, "INTEL-04 no longer has a NOT IN vocabulary list").toBeTruthy();
    const listed = [...(notIn?.[1].matchAll(/'([a-z_]+)'/g) ?? [])].map((match) => match[1]).sort();
    expect(listed).toEqual(templateActions);
  });
});

describe("every invariant is phrased so that rows mean a violation", () => {
  it("gives each one an id, a title and a stated meaning", () => {
    for (const invariant of INVARIANTS) {
      expect(invariant.id, invariant.title).toMatch(/^(INTEL|REPORT)-\d{2}$/);
      expect(invariant.title.length).toBeGreaterThan(10);
      // The meaning is what an operator reads at 3am to decide whether this
      // matters. A check without one is a number nobody can act on.
      expect(invariant.meaning.length, invariant.id).toBeGreaterThan(60);
    }
  });

  it("uses ids that are unique", () => {
    const ids = INVARIANTS.map((invariant) => invariant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("selects rows rather than counts, so a violation names itself", () => {
    for (const invariant of INVARIANTS) {
      // `SELECT count(*)` always returns one row, which under "rows mean a
      // violation" would report every run as failed.
      expect(invariant.sql.trim(), invariant.id).not.toMatch(/^SELECT\s+count\(/i);
    }
  });
});

describe("runInvariants", () => {
  const probe: Invariant[] = [
    { id: "INTEL-01", title: "first invariant here", meaning: "x".repeat(70), sql: "SELECT 1" },
    { id: "INTEL-02", title: "second invariant here", meaning: "x".repeat(70), sql: "SELECT 2" },
  ];

  it("reports a clean database as no findings", async () => {
    const results = await runInvariants(async () => [], probe);
    expect(hasFindings(results)).toBe(false);
    expect(formatReport(results)).toContain("All invariants hold.");
  });

  it("reports returned rows as violations", async () => {
    const results = await runInvariants(async () => [{ id: "row-1" }], probe);
    expect(hasFindings(results)).toBe(true);
    expect(results[0].violations).toBe(1);
  });

  it("treats a query that ERRORS as a finding, never as a pass", async () => {
    // The failure mode this whole file exists for: a missing relation must not
    // read as "nothing wrong".
    const results = await runInvariants(async () => {
      throw new Error('relation "intelligence_runs" does not exist');
    }, probe);
    expect(hasFindings(results)).toBe(true);
    expect(results[0].error).toContain("does not exist");
    expect(formatReport(results)).toContain("ERROR");
  });

  it("keeps running after one invariant fails", async () => {
    let call = 0;
    const results = await runInvariants(async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return [];
    }, probe);
    // One broken check must not hide the state of every check after it.
    expect(results).toHaveLength(2);
    expect(results[1].error).toBeUndefined();
  });

  it("bounds how many rows it reports", async () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ id: index }));
    const results = await runInvariants(async () => many, [probe[0]]);
    expect(results[0].violations).toBe(500);
    expect(results[0].rows).toHaveLength(20);
  });
});
