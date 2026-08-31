/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * INTEL-SIGNALS-001 — extraction correctness, tenant isolation, idempotency.
 *
 * Runs against real PostgreSQL (PGlite) with the shipped migrations applied, so
 * the isolation and idempotency assertions exercise the actual SQL. See
 * harness.ts for why that matters.
 *
 * Two clients are seeded with deliberately similar data throughout. Every
 * assertion about client_a's output is paired with the question "and did any of
 * client_b's data reach it" — that pairing is the point of the file.
 */

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  makeConfig,
  resetTables,
  schema,
  seedClient,
  silentLogger,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let pg: PGlite;

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => db,
  get schema() {
    return schema;
  },
}));
vi.mock("../../../src/core/logger.js", () => silentLogger);
vi.mock("../../../src/core/config.js", () => ({
  getConfig: () => makeConfig({ INTELLIGENCE_MODE: "observe" }),
}));

import {
  extractSignals,
  keywordDropSeverity,
  urlToPath,
} from "../../../src/modules/intelligence/signal-extractor.js";

let clientA: string;
let clientB: string;
const NOW = new Date("2026-08-31T12:00:00Z");
const RECENT = new Date("2026-08-30T12:00:00Z");

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  await resetTables(pg);
  clientA = await seedClient(db, { domain: "client-a.test" });
  clientB = await seedClient(db, { domain: "client-b.test" });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function signalsFor(clientId: string) {
  return db
    .select()
    .from(schema.intelligenceSignals)
    .where(eq(schema.intelligenceSignals.clientId, clientId));
}

describe("keyword_drop", () => {
  beforeEach(async () => {
    // The brief's fixture: client_a's keyword falls out of the top ten.
    await db.insert(schema.serpRankings).values([
      {
        clientId: clientA,
        keyword: "metal roofing",
        position: 11,
        previousPosition: 3,
        checkedAt: RECENT,
      },
      // Same keyword, same shape, different tenant. Must never surface for A.
      {
        clientId: clientB,
        keyword: "metal roofing",
        position: 11,
        previousPosition: 3,
        checkedAt: RECENT,
      },
    ]);
  });

  it("creates only client_a's signal when extracting for client_a", async () => {
    const signals = await extractSignals(clientA, { now: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0].clientId).toBe(clientA);
    expect(signals[0].signalType).toBe("keyword_drop");
  });

  it("writes nothing for client_b when extracting for client_a", async () => {
    await extractSignals(clientA, { now: NOW });
    expect(await signalsFor(clientB)).toHaveLength(0);
  });

  it("gives the two clients different fingerprints for identical data", async () => {
    const a = await extractSignals(clientA, { now: NOW });
    const b = await extractSignals(clientB, { now: NOW });
    // Identical keyword, identical positions — the client id salt is the only
    // difference, and it must be enough. Equal fingerprints would mean one
    // tenant's upsert could land on the other's row.
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
  });

  it("grades severity by where the keyword landed, not only how far it fell", () => {
    expect(keywordDropSeverity(3, 11)).toBe("critical"); // out of the top ten
    expect(keywordDropSeverity(40, 55)).toBe("critical"); // fell 15
    expect(keywordDropSeverity(20, 26)).toBe("warning"); // fell 6
    expect(keywordDropSeverity(20, 23)).toBe("info"); // fell 3
  });

  it("ignores a move smaller than the minimum drop", async () => {
    await db.delete(schema.serpRankings);
    await db.insert(schema.serpRankings).values({
      clientId: clientA,
      keyword: "gutter repair",
      position: 5,
      previousPosition: 4,
      checkedAt: RECENT,
    });
    expect(await extractSignals(clientA, { now: NOW })).toHaveLength(0);
  });

  it("does not crash or invent a signal when positions are null", async () => {
    await db.delete(schema.serpRankings);
    await db.insert(schema.serpRankings).values([
      { clientId: clientA, keyword: "a", position: null, previousPosition: 3, checkedAt: RECENT },
      { clientId: clientA, keyword: "b", position: 11, previousPosition: null, checkedAt: RECENT },
      {
        clientId: clientA,
        keyword: "c",
        position: null,
        previousPosition: null,
        checkedAt: RECENT,
      },
    ]);
    // A null position means "no reading", not "position 0". Treating it as a
    // number either way would manufacture a drop out of missing data.
    expect(await extractSignals(clientA, { now: NOW })).toHaveLength(0);
  });
});

describe("bad_lcp_high_exit", () => {
  it("fires only where poor LCP and high exit coincide on the same page", async () => {
    await db.insert(schema.webVitals).values([
      {
        clientId: clientA,
        url: "https://client-a.test/slow",
        source: "psi",
        lcp: 6200,
        measuredAt: RECENT,
      },
      // Slow, but nobody leaves → not a signal.
      {
        clientId: clientA,
        url: "https://client-a.test/slow-ok",
        source: "psi",
        lcp: 6200,
        measuredAt: RECENT,
      },
      // Fast, high exit → a content problem, not a performance one.
      {
        clientId: clientA,
        url: "https://client-a.test/fast",
        source: "psi",
        lcp: 900,
        measuredAt: RECENT,
      },
    ]);
    await db.insert(schema.pageEngagement).values([
      {
        clientId: clientA,
        pagePath: "/slow",
        exitRate: 0.82,
        totalPageviews: 500,
        period: "7d",
        computedAt: RECENT,
      },
      {
        clientId: clientA,
        pagePath: "/slow-ok",
        exitRate: 0.12,
        totalPageviews: 500,
        period: "7d",
        computedAt: RECENT,
      },
      {
        clientId: clientA,
        pagePath: "/fast",
        exitRate: 0.91,
        totalPageviews: 500,
        period: "7d",
        computedAt: RECENT,
      },
    ]);

    const signals = await extractSignals(clientA, { now: NOW });
    const vitalsSignals = signals.filter((s) => s.signalType === "bad_lcp_high_exit");
    expect(vitalsSignals).toHaveLength(1);
    expect(vitalsSignals[0].subject).toBe("/slow");
  });

  it("does not join a vitals row to another client's engagement row", async () => {
    await db.insert(schema.webVitals).values({
      clientId: clientA,
      url: "https://client-a.test/shared-path",
      source: "psi",
      lcp: 7000,
      measuredAt: RECENT,
    });
    // Only client_b has the engagement half. If the join leaked across
    // tenants, client_a would get a signal built from B's numbers.
    await db.insert(schema.pageEngagement).values({
      clientId: clientB,
      pagePath: "/shared-path",
      exitRate: 0.95,
      totalPageviews: 900,
      period: "7d",
      computedAt: RECENT,
    });

    const signals = await extractSignals(clientA, { now: NOW });
    expect(signals.filter((s) => s.signalType === "bad_lcp_high_exit")).toHaveLength(0);
  });

  it("skips a page with only half the evidence", async () => {
    await db.insert(schema.webVitals).values({
      clientId: clientA,
      url: "https://client-a.test/no-engagement",
      source: "psi",
      lcp: 8000,
      measuredAt: RECENT,
    });
    expect(await extractSignals(clientA, { now: NOW })).toHaveLength(0);
  });

  it("normalizes a URL to a comparable path", () => {
    expect(urlToPath("https://x.test/Pricing?utm=1#top")).toBe("/pricing");
    expect(urlToPath("https://x.test/")).toBe("/");
    expect(urlToPath("not a url")).toBe("not a url");
  });
});

describe("citation_loss", () => {
  it("fires only where a citation was held and then lost", async () => {
    await db.insert(schema.aeoCitations).values([
      // Held, then lost → a real regression.
      {
        clientId: clientA,
        query: "best roofer",
        platform: "perplexity",
        cited: true,
        checkedAt: new Date("2026-08-25T12:00:00Z"),
      },
      {
        clientId: clientA,
        query: "best roofer",
        platform: "perplexity",
        cited: false,
        checkedAt: RECENT,
      },
      // Never cited → a platform with no data, not a loss.
      {
        clientId: clientA,
        query: "best roofer",
        platform: "placeholder-engine",
        cited: false,
        checkedAt: new Date("2026-08-25T12:00:00Z"),
      },
      {
        clientId: clientA,
        query: "best roofer",
        platform: "placeholder-engine",
        cited: false,
        checkedAt: RECENT,
      },
      // Still cited → nothing lost.
      {
        clientId: clientA,
        query: "roof repair",
        platform: "perplexity",
        cited: true,
        checkedAt: RECENT,
      },
    ]);

    const signals = await extractSignals(clientA, { now: NOW });
    const citationSignals = signals.filter((s) => s.signalType === "citation_loss");
    expect(citationSignals).toHaveLength(1);
    expect(citationSignals[0].subject).toBe("perplexity:best roofer");
  });

  it("ignores another client's citation history entirely", async () => {
    await db.insert(schema.aeoCitations).values([
      {
        clientId: clientB,
        query: "best roofer",
        platform: "perplexity",
        cited: true,
        checkedAt: new Date("2026-08-25T12:00:00Z"),
      },
      {
        clientId: clientB,
        query: "best roofer",
        platform: "perplexity",
        cited: false,
        checkedAt: RECENT,
      },
    ]);
    expect(await extractSignals(clientA, { now: NOW })).toHaveLength(0);
  });
});

describe("prospect_ready", () => {
  it("respects the domain-rating floor and the ready status", async () => {
    await db.insert(schema.linkProspects).values([
      {
        clientId: clientA,
        targetUrl: "https://good.test/write-for-us",
        contactEmail: "e@good.test",
        domainRating: 45,
        tactic: "guest_post",
        status: "ready",
      },
      // Below the floor.
      {
        clientId: clientA,
        targetUrl: "https://weak.test/x",
        contactEmail: "e@weak.test",
        domainRating: 5,
        tactic: "guest_post",
        status: "ready",
      },
      // Unknown authority is not passing authority.
      {
        clientId: clientA,
        targetUrl: "https://unknown.test/x",
        contactEmail: "e@unknown.test",
        domainRating: null,
        tactic: "guest_post",
        status: "ready",
      },
      // Not ready yet.
      {
        clientId: clientA,
        targetUrl: "https://early.test/x",
        contactEmail: "e@early.test",
        domainRating: 60,
        tactic: "guest_post",
        status: "discovered",
      },
      // No contact route.
      {
        clientId: clientA,
        targetUrl: "https://nocontact.test/x",
        contactEmail: null,
        domainRating: 60,
        tactic: "guest_post",
        status: "ready",
      },
    ]);

    const signals = await extractSignals(clientA, { now: NOW });
    const prospects = signals.filter((s) => s.signalType === "prospect_ready");
    expect(prospects).toHaveLength(1);
    expect(prospects[0].subject).toContain("good.test");
  });

  it("never records the prospect's email address in the evidence", async () => {
    await db.insert(schema.linkProspects).values({
      clientId: clientA,
      targetUrl: "https://good.test/write-for-us",
      contactEmail: "private.person@good.test",
      domainRating: 45,
      tactic: "guest_post",
      status: "ready",
    });
    const [signal] = await extractSignals(clientA, { now: NOW });
    // The evidence blob reaches an LLM prompt and the operator API. PII in it
    // would be distributed to both.
    expect(JSON.stringify(signal.evidence)).not.toContain("private.person");
  });
});

describe("idempotency under at-least-once delivery", () => {
  beforeEach(async () => {
    await db.insert(schema.serpRankings).values({
      clientId: clientA,
      keyword: "metal roofing",
      position: 11,
      previousPosition: 3,
      checkedAt: RECENT,
    });
  });

  it("updates the same row on a second run rather than inserting a duplicate", async () => {
    const first = await extractSignals(clientA, { now: NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await extractSignals(clientA, { now: later });

    expect(second[0].fingerprint).toBe(first[0].fingerprint);

    const rows = await signalsFor(clientA);
    expect(rows).toHaveLength(1);
    // observed_at moves forward; first_observed_at is a historical fact and
    // stays put; the signal is still open.
    expect(rows[0].observedAt.getTime()).toBe(later.getTime());
    expect(rows[0].firstObservedAt.getTime()).toBe(NOW.getTime());
    expect(rows[0].status).toBe("open");
  });

  it("refreshes the evidence when the reading worsens", async () => {
    await extractSignals(clientA, { now: NOW });
    await db
      .update(schema.serpRankings)
      .set({ position: 25 })
      .where(eq(schema.serpRankings.clientId, clientA));

    await extractSignals(clientA, { now: new Date(NOW.getTime() + 3_600_000) });

    const rows = await signalsFor(clientA);
    expect(rows).toHaveLength(1);
    expect((rows[0].evidence as Record<string, number>).currentPosition).toBe(25);
  });

  it("does not resurrect a signal an operator suppressed", async () => {
    await extractSignals(clientA, { now: NOW });
    await db
      .update(schema.intelligenceSignals)
      .set({ status: "suppressed" })
      .where(eq(schema.intelligenceSignals.clientId, clientA));

    await extractSignals(clientA, { now: new Date(NOW.getTime() + 3_600_000) });

    const rows = await signalsFor(clientA);
    expect(rows).toHaveLength(1);
    // Suppression is an operator instruction. The next scheduled run must not
    // quietly undo it.
    expect(rows[0].status).toBe("suppressed");
  });
});

describe("input guards", () => {
  it.each([undefined, null, "", "   "])(
    "throws rather than running unscoped for %j",
    async (value) => {
      await expect(extractSignals(value as unknown as string, { now: NOW })).rejects.toThrow(
        /clientId is required/,
      );
    },
  );

  it("returns empty for a client with no data at all", async () => {
    const empty = await seedClient(db, { domain: "empty.test" });
    await expect(extractSignals(empty, { now: NOW })).resolves.toEqual([]);
  });

  it("ignores readings older than the lookback window", async () => {
    await db.insert(schema.serpRankings).values({
      clientId: clientA,
      keyword: "ancient",
      position: 40,
      previousPosition: 2,
      checkedAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await extractSignals(clientA, { now: NOW })).toHaveLength(0);
  });
});

describe("cross-tenant sweep", () => {
  it("never writes a signal whose client_id differs from the extraction scope", async () => {
    // Populate BOTH tenants across every producer table, then extract for each
    // in turn and assert the outputs are disjoint by client_id.
    for (const clientId of [clientA, clientB]) {
      await db.insert(schema.serpRankings).values({
        clientId,
        keyword: "shared kw",
        position: 15,
        previousPosition: 4,
        checkedAt: RECENT,
      });
      await db.insert(schema.webVitals).values({
        clientId,
        url: "https://x.test/p",
        source: "psi",
        lcp: 9000,
        measuredAt: RECENT,
      });
      await db.insert(schema.pageEngagement).values({
        clientId,
        pagePath: "/p",
        exitRate: 0.9,
        totalPageviews: 200,
        period: "7d",
        computedAt: RECENT,
      });
      await db.insert(schema.aeoCitations).values([
        {
          clientId,
          query: "q",
          platform: "perplexity",
          cited: true,
          checkedAt: new Date("2026-08-25T12:00:00Z"),
        },
        { clientId, query: "q", platform: "perplexity", cited: false, checkedAt: RECENT },
      ]);
      await db.insert(schema.linkProspects).values({
        clientId,
        targetUrl: "https://p.test/x",
        contactEmail: "e@p.test",
        domainRating: 50,
        tactic: "guest_post",
        status: "ready",
      });
    }

    await extractSignals(clientA, { now: NOW });
    await extractSignals(clientB, { now: NOW });

    const all = await db.select().from(schema.intelligenceSignals);
    expect(all.length).toBeGreaterThan(0);

    const rowsA = all.filter((r) => r.clientId === clientA);
    const rowsB = all.filter((r) => r.clientId === clientB);
    expect(rowsA.length).toBe(rowsB.length);
    // Every fingerprint is unique to its tenant — no shared identity anywhere.
    const fpA = new Set(rowsA.map((r) => r.fingerprint));
    const fpB = new Set(rowsB.map((r) => r.fingerprint));
    for (const fp of fpA) expect(fpB.has(fp)).toBe(false);
  });

  it("keeps a suppressed signal scoped to its own tenant", async () => {
    await db.insert(schema.serpRankings).values([
      { clientId: clientA, keyword: "kw", position: 15, previousPosition: 4, checkedAt: RECENT },
      { clientId: clientB, keyword: "kw", position: 15, previousPosition: 4, checkedAt: RECENT },
    ]);
    await extractSignals(clientA, { now: NOW });
    await extractSignals(clientB, { now: NOW });

    await db
      .update(schema.intelligenceSignals)
      .set({ status: "suppressed" })
      .where(
        and(
          eq(schema.intelligenceSignals.clientId, clientA),
          eq(schema.intelligenceSignals.signalType, "keyword_drop"),
        ),
      );

    const rowsB = await signalsFor(clientB);
    expect(rowsB.every((r) => r.status === "open")).toBe(true);
  });
});
