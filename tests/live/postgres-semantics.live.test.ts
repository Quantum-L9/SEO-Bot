/* L9_META
 * layer: test
 * role: live_integration_test
 * status: active
 */

/**
 * The properties the fakes CLAIM, checked against the thing they imitate.
 *
 * `docs/seo-sql/TESTING.md` names three: at-least-once delivery,
 * `ON CONFLICT DO NOTHING` returning nothing, and a fresh row getting a fresh
 * id. The third is not hypothetical — a mock that reused row ids let a test
 * pass against a dedup key that deduplicated nothing. The mock was fixed and
 * the assertion re-verified, but the fix was still one fake being corrected by
 * hand against a belief about Postgres.
 *
 * This file removes the belief. Each test asserts the property directly, on the
 * real tables and the real indexes the runner writes through.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, dropClient, liveServicesUnavailable, seedClient } from "./services.js";

const skip = await liveServicesUnavailable();

describe.skipIf(skip)("what the fakes promise, on real Postgres", () => {
  let ctx: ReturnType<typeof connect>;
  let clientId: string;
  let otherClientId: string;
  let runId: string;

  beforeAll(async () => {
    ctx = connect();
    clientId = await seedClient(ctx.db, `live-a-${Date.now()}`);
    otherClientId = await seedClient(ctx.db, `live-b-${Date.now()}`);
    const run = await ctx.db.execute(sql`
      INSERT INTO intelligence_runs (client_id, run_type, trigger_source, status)
      VALUES (${clientId}::uuid, 'client_triage', 'test', 'running')
      RETURNING id
    `);
    runId = (run as unknown as { rows: { id: string }[] }).rows[0].id;
  });

  afterAll(async () => {
    await dropClient(ctx.db, clientId);
    await dropClient(ctx.db, otherClientId);
    await ctx.pool.end();
  });

  async function insertSignal(fingerprint: string) {
    const result = await ctx.db.execute(sql`
      INSERT INTO intelligence_signals
        (run_id, client_id, entity_type, entity_id, signal_type, severity, confidence,
         evidence, fingerprint)
      VALUES
        (${runId}::uuid, ${clientId}::uuid, 'page', '/roofing', 'keyword_drop', 'high', 0.85,
         '{}'::jsonb, ${fingerprint})
      ON CONFLICT (run_id, fingerprint) DO NOTHING
      RETURNING id
    `);
    return (result as unknown as { rows: { id: string }[] }).rows;
  }

  it("returns the row on the first insert and NOTHING on the conflicting one", async () => {
    // This is the property the runner's idempotency rests on: BullMQ is
    // at-least-once, so the same cycle can execute twice, and the second pass
    // must be able to TELL that it did nothing.
    const first = await insertSignal("live-conflict-fingerprint");
    expect(first.length, "the first insert should return its row").toBe(1);

    const second = await insertSignal("live-conflict-fingerprint");
    expect(second.length, "a conflicting insert must return no row").toBe(0);
  });

  it("gives a genuinely fresh row a genuinely fresh id", async () => {
    // The exact fake defect: a mock that reused row ids made a broken dedup key
    // look like a working one, because every "new" row answered to the previous
    // row's identity.
    const one = await insertSignal("live-fresh-id-1");
    const two = await insertSignal("live-fresh-id-2");
    expect(one.length).toBe(1);
    expect(two.length).toBe(1);
    expect(two[0].id).not.toBe(one[0].id);
  });

  it("rejects the same fingerprint twice in one run even without the ON CONFLICT clause", async () => {
    // Without this, the clause above is politeness rather than a constraint —
    // any code path that forgot it would double-record in silence.
    await expect(
      ctx.db.execute(sql`
        INSERT INTO intelligence_signals
          (run_id, client_id, entity_type, entity_id, signal_type, severity, confidence,
           evidence, fingerprint)
        VALUES
          (${runId}::uuid, ${clientId}::uuid, 'page', '/x', 'keyword_drop', 'high', 0.85,
           '{}'::jsonb, 'live-conflict-fingerprint')
      `),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("lets the SAME fingerprint through on a DIFFERENT run", async () => {
    // The index is (run_id, fingerprint), not fingerprint alone. A signal that
    // recurs next cycle is a new observation; suppression, not the index, is
    // what decides whether to act on it. A fingerprint-only unique index would
    // make a recurring problem invisible after its first sighting.
    const otherRun = await ctx.db.execute(sql`
      INSERT INTO intelligence_runs (client_id, run_type, trigger_source, status)
      VALUES (${clientId}::uuid, 'client_triage', 'test', 'running')
      RETURNING id
    `);
    const otherRunId = (otherRun as unknown as { rows: { id: string }[] }).rows[0].id;
    const inserted = await ctx.db.execute(sql`
      INSERT INTO intelligence_signals
        (run_id, client_id, entity_type, entity_id, signal_type, severity, confidence,
         evidence, fingerprint)
      VALUES
        (${otherRunId}::uuid, ${clientId}::uuid, 'page', '/roofing', 'keyword_drop', 'high',
         0.85, '{}'::jsonb, 'live-conflict-fingerprint')
      ON CONFLICT (run_id, fingerprint) DO NOTHING
      RETURNING id
    `);
    expect((inserted as unknown as { rows: unknown[] }).rows.length).toBe(1);
  });

  it("scopes a tenant-filtered read to that tenant, with a second tenant present", async () => {
    // INTEL-10 asserts this after the fact, over whatever rows a run left. Here
    // there is a second tenant holding a row that WOULD match if the filter
    // were dropped, which is the only way the assertion means anything.
    await ctx.db.execute(sql`
      INSERT INTO aeo_citations (client_id, query, platform, cited, competitor_cited)
      VALUES (${otherClientId}::uuid, 'roof repair austin', 'perplexity', false, 'rival.example')
    `);
    const rows = await ctx.db.execute(sql`
      SELECT client_id FROM aeo_citations WHERE client_id = ${clientId}::uuid
    `);
    expect((rows as unknown as { rows: unknown[] }).rows.length).toBe(0);

    const unscoped = await ctx.db.execute(sql`
      SELECT client_id FROM aeo_citations WHERE query = 'roof repair austin'
    `);
    expect(
      (unscoped as unknown as { rows: unknown[] }).rows.length,
      "the other tenant's row must exist, or the test above proves nothing",
    ).toBeGreaterThan(0);
  });
});
