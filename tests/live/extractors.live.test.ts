/* L9_META
 * layer: test
 * role: live_integration_test
 * status: active
 */

/**
 * Every extractor's SQL, executed against the migrated schema.
 *
 * `signal-extractor.test.ts` calls `mapRow` with hand-built row objects, which
 * is the right way to test the mapping and says nothing at all about the query
 * above it. A `query()` naming a column that does not exist, joining a view
 * that was renamed, or writing a CTE Postgres rejects passes every test in this
 * repo and fails for the first time in production, inside a `try` that logs the
 * failure and lets the cycle continue with one extractor silently dead.
 *
 * The registry test asserts each query mentions the tenant id. This asserts the
 * query RUNS, and that the tenant filter it mentions actually filters.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpportunities } from "../../src/intelligence/opportunity-scorer.js";
import {
  allExtractors,
  competitorCitationExtractor,
  extractSignals,
} from "../../src/intelligence/signal-extractor.js";
import { connect, dropClient, liveServicesUnavailable, seedClient } from "./services.js";

const skip = await liveServicesUnavailable();

const KEYWORD = "roof repair austin";
const RANKING_URL = "https://live.example/roofing";

describe.skipIf(skip)("extractor SQL against the migrated schema", () => {
  let ctx: ReturnType<typeof connect>;
  let clientId: string;
  let otherClientId: string;

  beforeAll(async () => {
    ctx = connect();
    clientId = await seedClient(ctx.db, `live-ex-${Date.now()}`);
    otherClientId = await seedClient(ctx.db, `live-ex-other-${Date.now()}`);

    // A tracked keyword that lost 60 positions this week...
    await ctx.db.execute(sql`
      INSERT INTO serp_rankings (client_id, keyword, position, previous_position, url, device, checked_at)
      VALUES (${clientId}::uuid, ${KEYWORD}, 63, 3, ${RANKING_URL}, 'desktop', now())
    `);
    // ...and, on the SAME query, an answer engine citing a competitor instead.
    for (let i = 0; i < 6; i += 1) {
      await ctx.db.execute(sql`
        INSERT INTO aeo_citations (client_id, query, platform, cited, competitor_cited, checked_at)
        VALUES (${clientId}::uuid, ${KEYWORD}, 'perplexity', false, 'rival.example', now())
      `);
    }
    // A second tenant with identical-looking data. Every assertion below is
    // worth nothing without it: a query missing its client filter would return
    // the same shape and pass.
    await ctx.db.execute(sql`
      INSERT INTO serp_rankings (client_id, keyword, position, previous_position, url, device, checked_at)
      VALUES (${otherClientId}::uuid, ${KEYWORD}, 90, 2, 'https://other.example/roofing', 'desktop', now())
    `);
    for (let i = 0; i < 6; i += 1) {
      await ctx.db.execute(sql`
        INSERT INTO aeo_citations (client_id, query, platform, cited, competitor_cited, checked_at)
        VALUES (${otherClientId}::uuid, ${KEYWORD}, 'perplexity', false, 'other-rival.example', now())
      `);
    }
  });

  afterAll(async () => {
    await dropClient(ctx.db, clientId);
    await dropClient(ctx.db, otherClientId);
    await ctx.pool.end();
  });

  it("executes every extractor's query without error", async () => {
    // Named per extractor rather than looped into one assertion, so a failure
    // says WHICH query Postgres rejected instead of that one of eight did.
    for (const extractor of allExtractors(200)) {
      await expect(
        ctx.db.execute(extractor.query(clientId)),
        `${extractor.signalType}: its query does not run against the migrated schema`,
      ).resolves.toBeDefined();
    }
  });

  it("returns the keyword drop through the reporting view, for this tenant only", async () => {
    const rows = await ctx.db.execute(sql`
      SELECT keyword, url, position_delta FROM reporting.keyword_drops_7d
      WHERE client_id = ${clientId}::uuid
    `);
    const list = (rows as unknown as { rows: { keyword: string; url: string }[] }).rows;
    expect(list.length).toBe(1);
    expect(list[0].keyword).toBe(KEYWORD);
    expect(list[0].url).toBe(RANKING_URL);
  });

  it("emits BOTH citation scopes from one query, with the keyword scope joined to the drop", async () => {
    // The join TODO.md §3 said needed a schema change. It needed none: the
    // per-row `query` was always there, and only the per-platform rollup
    // discarded it.
    const rows = await ctx.db.execute(competitorCitationExtractor.query(clientId));
    const list = (rows as unknown as { rows: Record<string, unknown>[] }).rows;
    const scopes = list.map((row) => row.scope).sort();
    expect(scopes).toEqual(["keyword", "platform"]);

    const keywordRow = list.find((row) => row.scope === "keyword");
    expect(keywordRow?.keyword).toBe(KEYWORD);
    expect(keywordRow?.url).toBe(RANKING_URL);
    expect(Number(keywordRow?.position_delta)).toBe(60);
    // The scopes overlap by design: the same six rows count toward both.
    const platformRow = list.find((row) => row.scope === "platform");
    expect(Number(platformRow?.occurrences)).toBe(6);
    expect(Number(keywordRow?.occurrences)).toBe(6);
    // And neither carries the other tenant's competitor.
    expect(list.map((row) => row.competitor_cited)).toEqual(["rival.example", "rival.example"]);
  });

  it("forms the compound diagnosis end to end, from rows to a scored opportunity", async () => {
    // Everything else about this fix is asserted through `mapRow` on
    // hand-built rows. This is the only place the whole path runs: real SQL
    // over real rows, through the real extractors, into the real scorer.
    const { signals, failures } = await extractSignals(clientId, allExtractors(200));
    expect(failures, "an extractor failed against the real database").toEqual([]);

    const { opportunities } = buildOpportunities(signals);
    const compound = opportunities.find(
      (opportunity) => opportunity.opportunityType === "serp_and_answer_engine_loss",
    );
    expect(compound, "the compound diagnosis did not form from real rows").toBeDefined();
    expect(compound?.score).toBeGreaterThanOrEqual(20);

    // The platform-scoped signal still stands on its own alongside it.
    expect(opportunities.map((o) => o.opportunityType).sort()).toEqual([
      "answer_engine_gap",
      "serp_and_answer_engine_loss",
    ]);
  });

  it("returns nothing at all for a tenant with no data", async () => {
    const empty = await seedClient(ctx.db, `live-ex-empty-${Date.now()}`);
    try {
      const { signals, failures } = await extractSignals(empty, allExtractors(200));
      expect(failures).toEqual([]);
      expect(signals).toEqual([]);
    } finally {
      await dropClient(ctx.db, empty);
    }
  });
});
