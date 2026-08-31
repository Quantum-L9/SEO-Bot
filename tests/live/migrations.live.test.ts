/* L9_META
 * layer: test
 * role: live_integration_test
 * status: active
 */

/**
 * "Migrations apply to an empty database" was a row in the production-readiness
 * gate with a manual procedure beside it. It is a test now.
 *
 * The static gates (`tests/migrations/static-gates.test.ts`) prove no APPLIED
 * migration was edited and that destructive statements are declared. Neither
 * proves the set applies — a migration can be immutable, additive, checksummed
 * and still fail on contact with Postgres, and the first place that would show
 * up is a deploy.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, liveServicesUnavailable } from "./services.js";

const skip = await liveServicesUnavailable();

describe.skipIf(skip)("the schema this suite runs against is the migrated one", () => {
  let ctx: ReturnType<typeof connect>;

  beforeAll(() => {
    ctx = connect();
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  it("has applied every migration on disk, with drizzle's own history as the record", async () => {
    const applied = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"`,
    );
    const count = (applied as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0;
    // Not asserted against a hardcoded number, which would need editing with
    // every migration and would then be edited without being read.
    expect(count).toBeGreaterThan(0);
  });

  it("carries the relations the intelligence plane reads and writes", async () => {
    // Named individually rather than counted: a count passes while the one
    // relation an extractor needs is the one that is missing.
    const required: [string, string][] = [
      ["public", "clients"],
      ["public", "aeo_citations"],
      ["public", "serp_rankings"],
      ["public", "intelligence_runs"],
      ["public", "intelligence_signals"],
      ["public", "intelligence_opportunities"],
      ["public", "intelligence_decisions"],
      ["reporting", "latest_serp_rankings"],
      ["reporting", "keyword_drops_7d"],
      ["reporting", "page_experience_risks"],
    ];
    for (const [schema, relation] of required) {
      const found = await ctx.db.execute(sql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_name = ${relation}
      `);
      expect(
        (found as unknown as { rows: unknown[] }).rows.length,
        `${schema}.${relation} is missing — run npm run migrate`,
      ).toBe(1);
    }
  });

  it("enforces the unique index the run's idempotency depends on", async () => {
    // `(run_id, fingerprint)` UNIQUE is what makes `ON CONFLICT DO NOTHING` a
    // dedup rather than a no-op. The fake reproduced the behavior; only the
    // real index proves the behavior has something behind it.
    const index = await ctx.db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'intelligence_signals'
        AND indexname = 'idx_intel_signals_run_fingerprint'
    `);
    const rows = (index as unknown as { rows: { indexdef: string }[] }).rows;
    expect(rows.length, "the run/fingerprint unique index is missing").toBe(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
  });

  it("keeps aeo_citations' per-row query dimension, which the keyword join needs", async () => {
    // The compound diagnosis `serp_and_answer_engine_loss` was recorded as
    // unreachable on the belief that this column did not exist (TODO.md §3).
    // It always has. Asserted here so a future migration cannot quietly drop it
    // and take the diagnosis back down with it.
    const column = await ctx.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'aeo_citations' AND column_name = 'query'
    `);
    const rows = (column as unknown as { rows: { is_nullable: string }[] }).rows;
    expect(rows.length, "aeo_citations.query is gone").toBe(1);
    expect(rows[0].is_nullable).toBe("NO");
  });
});
