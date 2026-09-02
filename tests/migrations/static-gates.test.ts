/* L9_META
 * layer: test
 * role: migration_contract_test
 * status: active
 */

/**
 * Testing contract §2 — the static gates, as tests rather than as a checklist.
 *
 * The contract lists four conditions that must fail a run before any runtime
 * test is worth doing. Three of them are things a reviewer is expected to notice
 * by eye, which is another way of saying nothing enforces them:
 *
 *   - a migration was hand-edited after it was applied
 *   - a migration is non-additive without explicit approval
 *   - a new env var is not declared in src/core/config.ts
 *   - ModuleName does not include "intelligence"
 *
 * The fourth static gate — "intelligence jobs lack tokenBudget declarations" —
 * is already enforced by `tests/intelligence/registration.test.ts` against the
 * live scheduler definitions, which is a stronger check than anything a file
 * scan could do. It is deliberately not duplicated here; a second copy of an
 * invariant is a second place for it to rot.
 *
 * Everything below reads the repository as shipped. No mocks: the artifact under
 * test IS the file.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "drizzle");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: JournalEntry[];
};

const checksums = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "CHECKSUMS.json"), "utf8")) as {
  schema_version: string;
  migrations: Record<string, string>;
};

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("static gate — an applied migration is immutable", () => {
  // drizzle's journal records THAT a tag ran, never what it said. So an edit to
  // an already-applied migration is invisible to every tool in the repo: the
  // deployed database keeps the old text, the file claims the new one, and the
  // two never reconcile because the migration will not run again.
  it("matches every migration against its recorded checksum", () => {
    for (const file of migrationFiles) {
      const tag = file.replace(/\.sql$/, "");
      const recorded = checksums.migrations[tag];
      expect(recorded, `${tag} has no checksum recorded in drizzle/CHECKSUMS.json`).toBeDefined();
      const actual = createHash("sha256")
        .update(readFileSync(join(MIGRATIONS_DIR, file)))
        .digest("hex");
      expect(
        actual,
        `${tag}.sql no longer matches its checksum. If this migration has already been applied ` +
          `anywhere, editing it leaves those databases divergent — add a NEW migration instead. ` +
          `If it genuinely has not shipped, update drizzle/CHECKSUMS.json in the same commit.`,
      ).toBe(recorded);
    }
  });

  it("records a checksum for exactly the migrations that exist", () => {
    const onDisk = migrationFiles.map((file) => file.replace(/\.sql$/, "")).sort();
    expect(Object.keys(checksums.migrations).sort()).toEqual(onDisk);
  });
});

describe("static gate — migrations are additive", () => {
  /**
   * Statements that destroy or narrow something that already exists. Each needs
   * an explicit approval marker on a line above it:
   *
   *     -- l9:non-additive: <why this is safe here>
   *     DROP MATERIALIZED VIEW reporting.stale_thing;
   *
   * The marker is not a rubber stamp — it is the sentence a reviewer reads to
   * decide. What it buys is that the decision cannot be made silently.
   */
  const DESTRUCTIVE = [
    /\bDROP\s+(TABLE|SCHEMA|COLUMN|VIEW|MATERIALIZED\s+VIEW|INDEX|FUNCTION|TYPE|ROLE)\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+TABLE\s+[^;]*\bRENAME\b/i,
    /\bALTER\s+COLUMN\s+[^;]*\b(TYPE|SET\s+NOT\s+NULL)\b/i,
  ];
  const APPROVAL = /--\s*l9:non-additive:/i;

  it("flags no unapproved destructive statement in any migration", () => {
    for (const file of migrationFiles) {
      const lines = readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        const statement = line.trim();
        if (statement.startsWith("--")) return;
        const matched = DESTRUCTIVE.find((pattern) => pattern.test(statement));
        if (!matched) return;
        // The marker may sit on this line as a trailing comment, or on the
        // preceding non-blank line.
        const previous = [...lines.slice(0, index)].reverse().find((l) => l.trim() !== "") ?? "";
        const approved = APPROVAL.test(line) || APPROVAL.test(previous);
        expect(
          approved,
          `${file}:${index + 1} is non-additive and carries no approval marker:\n  ${statement}\n` +
            `Add "-- l9:non-additive: <reason>" above it, or make the change additive.`,
        ).toBe(true);
      });
    }
  });

  it("recognises an approval marker rather than banning the statement outright", () => {
    // Guards the guard: proves the escape hatch is reachable, so the rule above
    // is "declare it", not "it can never be done" — which is what would push a
    // future author to delete the check instead of using it.
    const withMarker = ["-- l9:non-additive: replaced by 0007", "DROP VIEW reporting.old;"];
    const previous = withMarker[0];
    expect(APPROVAL.test(previous)).toBe(true);
    expect(DESTRUCTIVE.some((pattern) => pattern.test(withMarker[1]))).toBe(true);
  });
});

describe("static gate — the journal is complete and ordered", () => {
  it("registers every migration file, and every registered tag has a file", () => {
    const registered = journal.entries.map((entry) => entry.tag).sort();
    const onDisk = migrationFiles.map((file) => file.replace(/\.sql$/, "")).sort();
    expect(registered).toEqual(onDisk);
  });

  it("keeps `when` strictly increasing in idx order", () => {
    const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(
        ordered[i].when,
        `${ordered[i].tag} must sort after ${ordered[i - 1].tag}`,
      ).toBeGreaterThan(ordered[i - 1].when);
    }
  });

  it("numbers idx contiguously from zero, so no migration was removed", () => {
    const indices = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(indices).toEqual(indices.map((_, i) => i));
  });

  it("names each file with the idx it is registered under", () => {
    for (const entry of journal.entries) {
      expect(entry.tag.startsWith(String(entry.idx).padStart(4, "0")), entry.tag).toBe(true);
    }
  });
});

describe("static gate — every env var read is declared in config.ts", () => {
  const config = readFileSync(join(ROOT, "src", "core", "config.ts"), "utf8");
  const schemaBlock = config.slice(
    config.indexOf("const envSchema"),
    config.indexOf("\n});", config.indexOf("const envSchema")),
  );
  const declared = new Set(
    [...schemaBlock.matchAll(/^ {2}([A-Z][A-Z_0-9]*):/gm)].map((match) => match[1]),
  );

  /**
   * Variables read straight from `process.env` on purpose, with the reason.
   *
   * Each is read at a point where the validated config either does not exist yet
   * or must not be consulted. This is an allow-list, not an exemption: a var that
   * is not here and not in the schema fails the test.
   */
  const RUNTIME_ONLY: Record<string, string> = {
    // Read by the dry-run kill switches and by the test harness itself, before
    // and independently of config validation.
    NODE_ENV: "process-level; read by the site-deployment dry-run guard",
    // The secrets loader bootstraps Infisical BEFORE the schema can be parsed —
    // the schema's own required values are what Infisical supplies.
    INFISICAL_CLIENT_ID: "secrets bootstrap, runs before config validation",
    INFISICAL_CLIENT_SECRET: "secrets bootstrap, runs before config validation",
    INFISICAL_PROJECT_ID: "secrets bootstrap, runs before config validation",
  };

  it("declares, or explicitly exempts, every process.env read in src/", () => {
    const undeclared = new Map<string, string[]>();

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(path));
        else if (entry.name.endsWith(".ts")) out.push(path);
      }
      return out;
    };

    for (const file of walk(join(ROOT, "src"))) {
      if (file.endsWith(join("core", "config.ts"))) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)) {
        const name = match[1];
        if (declared.has(name) || name in RUNTIME_ONLY) continue;
        const relative = file.slice(ROOT.length + 1);
        undeclared.set(name, [...(undeclared.get(name) ?? []), relative]);
      }
    }

    expect(
      Object.fromEntries(undeclared),
      "Every environment variable the app reads is validated at startup by " +
        "src/core/config.ts, so a missing or malformed value fails the boot rather " +
        "than surfacing as undefined halfway through a job. Declare it there, or " +
        "add it to RUNTIME_ONLY above with the reason it cannot be.",
    ).toEqual({});
  });

  it("keeps the exemption list honest — every entry is really read somewhere", () => {
    // An exemption nobody uses is a hole held open for no reason.
    const sources = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
      .filter((name) => typeof name === "string" && name.endsWith(".ts"))
      .map((name) => readFileSync(join(ROOT, "src", name), "utf8"))
      .join("\n");
    for (const name of Object.keys(RUNTIME_ONLY)) {
      expect(sources.includes(`process.env.${name}`), `${name} is exempted but never read`).toBe(
        true,
      );
    }
  });

  it("documents every operator-tunable variable in .env.example", () => {
    // A dial the operator cannot find is a dial that does not exist. This is
    // what a staged cutover reads to know INTELLIGENCE_MODE has rungs at all.
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z_0-9]*)=/gm)].map((match) => match[1]),
    );
    const missing = [...declared].filter((name) => !documented.has(name)).sort();
    expect(missing, "declared in config.ts but absent from .env.example").toEqual([]);
  });

  it("finds the schema block it claims to be reading", () => {
    // If the slice above ever misses (config.ts is restructured), `declared`
    // would be empty and all three tests would pass vacuously.
    expect(declared.size).toBeGreaterThan(20);
    expect(declared.has("INTELLIGENCE_MODE")).toBe(true);
    expect(declared.has("DATABASE_URL")).toBe(true);
  });
});

describe("static gate — the plane's module identity exists", () => {
  it("declares intelligence and reporting on ModuleName", async () => {
    // action_log.module is typed by this union. Without the member, every row
    // the plane writes would be attributed to some other module's name, and the
    // SQL verification pack's `WHERE module = 'intelligence'` would return
    // nothing while the plane ran unaudited.
    const types = readFileSync(join(ROOT, "src", "types", "index.ts"), "utf8");
    const union = types.slice(types.indexOf("export type ModuleName"));
    const body = union.slice(0, union.indexOf(";"));
    expect(body).toContain('"intelligence"');
    expect(body).toContain('"reporting"');
  });
});
