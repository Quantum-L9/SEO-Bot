/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Signal extraction is the only component that touches raw multi-tenant
 * operational tables, so tenant isolation is tested structurally rather than by
 * example: the DB fake RECORDS every WHERE clause, and the tests assert that a
 * client filter was applied on each query — not merely that client B's rows
 * happened not to appear in the output.
 *
 * That distinction matters. A test that seeds only client A's rows and checks
 * the output passes even against a query with no WHERE clause at all. Seeding
 * both tenants and inspecting the predicate catches the missing filter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT_A = "11111111-1111-1111-1111-111111111111";
const CLIENT_B = "22222222-2222-2222-2222-222222222222";

/** Rows the fake returns, keyed by table identity. */
const tables: Record<string, unknown[]> = {
  serpRankings: [],
  webVitals: [],
  pageEngagement: [],
  aeoCitations: [],
  linkProspects: [],
};

/** Every filter value passed to a `.where()` in this run. */
const observedFilters: Array<{ table: string; clientId: unknown }> = [];

/**
 * Minimal Drizzle-shaped query builder.
 *
 * `eq()` is stubbed to a tagged object so the fake can read which column and
 * value a query filtered on, which is what makes the isolation assertions real
 * rather than incidental.
 */
function makeSelect() {
  let currentTable = "";
  const builder: Record<string, unknown> = {
    from(table: { __name: string }) {
      currentTable = table.__name;
      return builder;
    },
    where(condition: unknown) {
      const conditions = Array.isArray(condition) ? condition : [condition];
      for (const c of conditions) {
        const tagged = c as { __col?: string; __value?: unknown };
        if (tagged?.__col === "clientId") {
          observedFilters.push({ table: currentTable, clientId: tagged.__value });
        }
      }
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      const rows = tables[currentTable] ?? [];
      const filters = observedFilters.filter((f) => f.table === currentTable);
      const clientId = filters.at(-1)?.clientId;
      // Emulate the DB actually honouring the predicate.
      return Promise.resolve(
        clientId === undefined
          ? rows
          : rows.filter((row) => (row as { clientId?: string }).clientId === clientId),
      );
    },
  };
  return builder;
}

const insertedRows: unknown[][] = [];
const onConflictReturning = vi.fn(async () => []);

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, value: unknown) => ({ __col: col, __value: value }),
  and: (...conditions: unknown[]) => conditions,
  desc: (col: unknown) => col,
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (v: unknown) => v },
  ),
}));

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => ({
    select: () => makeSelect(),
    insert: () => ({
      values: (rows: unknown[]) => {
        insertedRows.push(rows);
        return { onConflictDoUpdate: () => ({ returning: onConflictReturning }) };
      },
    }),
  }),
  schema: {
    serpRankings: { __name: "serpRankings", clientId: "clientId" },
    webVitals: { __name: "webVitals", clientId: "clientId" },
    pageEngagement: { __name: "pageEngagement", clientId: "clientId" },
    aeoCitations: { __name: "aeoCitations", clientId: "clientId" },
    linkProspects: { __name: "linkProspects", clientId: "clientId", status: "status" },
    intelligenceSignals: {
      __name: "intelligenceSignals",
      clientId: "clientId",
      fingerprint: "fingerprint",
      severity: "severity",
      strength: "strength",
      evidence: "evidence",
      observedAt: "observedAt",
      firstSeenAt: "firstSeenAt",
    },
  },
}));

vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  assertClientId,
  extractBadLcpHighExitSignals,
  extractCitationLossSignals,
  extractKeywordDropSignals,
  extractProspectReadySignals,
  extractSignals,
  normalizePagePath,
  severityForKeywordDrop,
  signalFingerprint,
  THRESHOLDS,
} from "../../../src/modules/intelligence/signal-extractor.js";

beforeEach(() => {
  for (const key of Object.keys(tables)) tables[key] = [];
  observedFilters.length = 0;
  insertedRows.length = 0;
  vi.clearAllMocks();
  onConflictReturning.mockResolvedValue([]);
});

// ─── Fixtures: BOTH tenants always seeded ────────────────────────────────────

function seedKeywords() {
  tables.serpRankings = [
    {
      clientId: CLIENT_A,
      keyword: "metal roofing",
      position: 11,
      previousPosition: 3,
      url: "https://a.com/roofing",
      checkedAt: new Date(),
    },
    {
      clientId: CLIENT_B,
      keyword: "client b keyword",
      position: 30,
      previousPosition: 2,
      url: "https://b.com/x",
      checkedAt: new Date(),
    },
  ];
}

describe("clientId is mandatory", () => {
  it.each([undefined, null, "", "   "])("throws for %p", async (value) => {
    await expect(extractKeywordDropSignals(value as never)).rejects.toThrow(/clientId is required/);
  });

  it("assertClientId narrows a valid id", () => {
    expect(() => assertClientId(CLIENT_A)).not.toThrow();
  });
});

describe("tenant isolation", () => {
  it("applies a clientId filter to every table it reads", async () => {
    seedKeywords();
    tables.webVitals = [];
    tables.pageEngagement = [];
    tables.aeoCitations = [];
    tables.linkProspects = [];

    await extractSignals(CLIENT_A);

    const filtered = new Set(observedFilters.map((f) => f.table));
    for (const table of [
      "serpRankings",
      "webVitals",
      "pageEngagement",
      "aeoCitations",
      "linkProspects",
    ]) {
      expect(filtered.has(table), `${table} was queried without a clientId filter`).toBe(true);
    }
    // And every filter used the requested client, never another.
    for (const filter of observedFilters) expect(filter.clientId).toBe(CLIENT_A);
  });

  it("never emits a signal for another client", async () => {
    seedKeywords();
    const signals = await extractKeywordDropSignals(CLIENT_A);
    expect(signals).toHaveLength(1);
    expect(signals.every((s) => s.clientId === CLIENT_A)).toBe(true);
    expect(signals.some((s) => s.entityKey === "client b keyword")).toBe(false);
  });

  it("fingerprints the same entity differently per tenant", () => {
    expect(signalFingerprint(CLIENT_A, "keyword_drop", "metal roofing")).not.toBe(
      signalFingerprint(CLIENT_B, "keyword_drop", "metal roofing"),
    );
  });

  it("produces a stable fingerprint for the same inputs", () => {
    expect(signalFingerprint(CLIENT_A, "keyword_drop", "metal roofing")).toBe(
      signalFingerprint(CLIENT_A, "keyword_drop", "metal roofing"),
    );
  });
});

describe("keyword_drop", () => {
  it("fires above the delta threshold", async () => {
    seedKeywords();
    const signals = await extractKeywordDropSignals(CLIENT_A);
    expect(signals[0].signalType).toBe("keyword_drop");
    expect(signals[0].evidence).toMatchObject({ delta: 8, currentPosition: 11 });
  });

  it("ignores a drop below the threshold", async () => {
    tables.serpRankings = [
      { clientId: CLIENT_A, keyword: "k", position: 4, previousPosition: 3, checkedAt: new Date() },
    ];
    expect(await extractKeywordDropSignals(CLIENT_A)).toHaveLength(0);
  });

  it("ignores an improvement", async () => {
    tables.serpRankings = [
      {
        clientId: CLIENT_A,
        keyword: "k",
        position: 2,
        previousPosition: 15,
        checkedAt: new Date(),
      },
    ];
    expect(await extractKeywordDropSignals(CLIENT_A)).toHaveLength(0);
  });

  it.each([
    ["null current position", null, 3],
    ["null previous position", 11, null],
    ["both null", null, null],
  ])("does not crash on %s", async (_label, position, previousPosition) => {
    // A null position means "not in the top 100", not "position 0". Treating it
    // as a number would manufacture a 100-place move.
    tables.serpRankings = [
      { clientId: CLIENT_A, keyword: "k", position, previousPosition, checkedAt: new Date() },
    ];
    await expect(extractKeywordDropSignals(CLIENT_A)).resolves.toEqual([]);
  });

  it("keeps only the most recent row per keyword", async () => {
    tables.serpRankings = [
      {
        clientId: CLIENT_A,
        keyword: "k",
        position: 12,
        previousPosition: 4,
        checkedAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        keyword: "k",
        position: 40,
        previousPosition: 4,
        checkedAt: new Date(0),
      },
    ];
    const signals = await extractKeywordDropSignals(CLIENT_A);
    expect(signals).toHaveLength(1);
    expect(signals[0].evidence).toMatchObject({ currentPosition: 12 });
  });

  it("scores severity by page-one loss, not delta alone", () => {
    // Losing #3 -> #11 costs nearly all the traffic; #40 -> #48 costs almost none.
    expect(severityForKeywordDrop(8, 11)).toBe("high");
    expect(severityForKeywordDrop(12, 20)).toBe("critical");
    expect(severityForKeywordDrop(8, 48)).toBe("medium");
    expect(severityForKeywordDrop(3, 8)).toBe("low");
  });
});

describe("bad_lcp_high_exit", () => {
  it("fires only where a slow page is ALSO a high-exit page", async () => {
    tables.webVitals = [
      {
        clientId: CLIENT_A,
        url: "https://a.com/pricing",
        lcp: 5.5,
        device: "mobile",
        measuredAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        url: "https://a.com/fast",
        lcp: 1.2,
        device: "mobile",
        measuredAt: new Date(),
      },
    ];
    tables.pageEngagement = [
      {
        clientId: CLIENT_A,
        pagePath: "/pricing",
        exitRate: 0.82,
        avgTimeOnPage: 8,
        uniqueVisitors: 90,
        computedAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        pagePath: "/fast",
        exitRate: 0.95,
        avgTimeOnPage: 3,
        uniqueVisitors: 40,
        computedAt: new Date(),
      },
    ];
    const signals = await extractBadLcpHighExitSignals(CLIENT_A);
    expect(signals).toHaveLength(1);
    expect(signals[0].entityKey).toBe("/pricing");
  });

  it("does not fire for a slow page with a healthy exit rate", async () => {
    tables.webVitals = [
      {
        clientId: CLIENT_A,
        url: "https://a.com/slow",
        lcp: 7,
        device: "mobile",
        measuredAt: new Date(),
      },
    ];
    tables.pageEngagement = [
      { clientId: CLIENT_A, pagePath: "/slow", exitRate: 0.1, computedAt: new Date() },
    ];
    expect(await extractBadLcpHighExitSignals(CLIENT_A)).toHaveLength(0);
  });

  it("joins a full URL against a stored path", () => {
    // The two tables key pages differently; without normalization the join
    // silently matches nothing and this signal type never fires at all.
    expect(normalizePagePath("https://a.com/pricing")).toBe("/pricing");
    expect(normalizePagePath("/pricing/")).toBe("/pricing");
    expect(normalizePagePath("pricing")).toBe("/pricing");
    expect(normalizePagePath("/")).toBe("/");
  });

  it("returns null for unusable path input rather than an empty join key", () => {
    expect(normalizePagePath(null)).toBeNull();
    expect(normalizePagePath("")).toBeNull();
    expect(normalizePagePath("   ")).toBeNull();
    expect(normalizePagePath("http://[bad")).toBeNull();
  });

  it("skips a null LCP without crashing", async () => {
    tables.webVitals = [
      { clientId: CLIENT_A, url: "https://a.com/x", lcp: null, measuredAt: new Date() },
    ];
    tables.pageEngagement = [
      { clientId: CLIENT_A, pagePath: "/x", exitRate: 0.9, computedAt: new Date() },
    ];
    expect(await extractBadLcpHighExitSignals(CLIENT_A)).toHaveLength(0);
  });
});

describe("citation_loss", () => {
  it("fires when a previously-cited query is no longer cited", async () => {
    tables.aeoCitations = [
      {
        clientId: CLIENT_A,
        platform: "perplexity",
        query: "best roofer",
        cited: false,
        competitorCited: "rival.com",
        checkedAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        platform: "perplexity",
        query: "best roofer",
        cited: true,
        checkedAt: new Date(0),
      },
    ];
    const signals = await extractCitationLossSignals(CLIENT_A);
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe("high");
  });

  it("ignores a platform that never cited the client", async () => {
    // "never cited here" and "was cited and lost it" are different facts; only
    // the second is a signal.
    tables.aeoCitations = [
      { clientId: CLIENT_A, platform: "chatgpt", query: "q", cited: false, checkedAt: new Date() },
      { clientId: CLIENT_A, platform: "chatgpt", query: "q", cited: false, checkedAt: new Date(0) },
    ];
    expect(await extractCitationLossSignals(CLIENT_A)).toHaveLength(0);
  });

  it("ignores a query that is still cited", async () => {
    tables.aeoCitations = [
      {
        clientId: CLIENT_A,
        platform: "perplexity",
        query: "q",
        cited: true,
        checkedAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        platform: "perplexity",
        query: "q",
        cited: true,
        checkedAt: new Date(0),
      },
    ];
    expect(await extractCitationLossSignals(CLIENT_A)).toHaveLength(0);
  });

  it("skips placeholder rows with no platform or query", async () => {
    tables.aeoCitations = [
      { clientId: CLIENT_A, platform: null, query: null, cited: false, checkedAt: new Date() },
    ];
    expect(await extractCitationLossSignals(CLIENT_A)).toHaveLength(0);
  });
});

describe("prospect_ready", () => {
  it("respects the domain-rating floor", async () => {
    tables.linkProspects = [
      {
        clientId: CLIENT_A,
        targetUrl: "https://good.com",
        domainRating: 60,
        contactEmail: "a@b.com",
        tactic: "guest_post",
        status: "discovered",
        relevanceScore: 0.7,
        createdAt: new Date(),
      },
      {
        clientId: CLIENT_A,
        targetUrl: "https://weak.com",
        domainRating: THRESHOLDS.prospectMinDomainRating - 1,
        contactEmail: "c@d.com",
        tactic: "guest_post",
        status: "discovered",
        relevanceScore: 0.7,
        createdAt: new Date(),
      },
    ];
    const signals = await extractProspectReadySignals(CLIENT_A);
    expect(signals).toHaveLength(1);
    expect(signals[0].entityKey).toBe("https://good.com");
  });

  it("requires a contact email", async () => {
    tables.linkProspects = [
      {
        clientId: CLIENT_A,
        targetUrl: "https://x.com",
        domainRating: 70,
        contactEmail: null,
        tactic: "t",
        status: "discovered",
        createdAt: new Date(),
      },
    ];
    expect(await extractProspectReadySignals(CLIENT_A)).toHaveLength(0);
  });

  it("never copies the contact email into evidence", async () => {
    // Evidence reaches the LLM planner and the operator API. A prospect's email
    // is PII with no bearing on whether to act.
    tables.linkProspects = [
      {
        clientId: CLIENT_A,
        targetUrl: "https://x.com",
        domainRating: 70,
        contactEmail: "editor@x.com",
        tactic: "t",
        status: "discovered",
        relevanceScore: 0.5,
        createdAt: new Date(),
      },
    ];
    const signals = await extractProspectReadySignals(CLIENT_A);
    expect(JSON.stringify(signals[0].evidence)).not.toContain("editor@x.com");
    expect(signals[0].evidence).toMatchObject({ hasContactEmail: true });
  });

  it("skips a null domain rating", async () => {
    tables.linkProspects = [
      {
        clientId: CLIENT_A,
        targetUrl: "https://x.com",
        domainRating: null,
        contactEmail: "a@b.com",
        tactic: "t",
        status: "discovered",
        createdAt: new Date(),
      },
    ];
    expect(await extractProspectReadySignals(CLIENT_A)).toHaveLength(0);
  });
});

describe("empty state", () => {
  it("returns no signals and writes nothing when a client has no data", async () => {
    const { signals, persisted } = await extractSignals(CLIENT_A);
    expect(signals).toEqual([]);
    expect(persisted).toEqual({ inserted: 0, updated: 0, total: 0 });
    expect(insertedRows).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("upserts on (clientId, fingerprint) rather than inserting again", async () => {
    seedKeywords();
    await extractSignals(CLIENT_A);
    const firstFingerprints = (insertedRows[0] as Array<{ fingerprint: string }>).map(
      (r) => r.fingerprint,
    );

    await extractSignals(CLIENT_A);
    const secondFingerprints = (insertedRows[1] as Array<{ fingerprint: string }>).map(
      (r) => r.fingerprint,
    );

    // Same fingerprints both runs => the unique index collapses them to one row.
    expect(secondFingerprints).toEqual(firstFingerprints);
  });

  it("refreshes observedAt on re-observation", async () => {
    seedKeywords();
    await extractSignals(CLIENT_A);
    const first = (insertedRows[0] as Array<{ observedAt: Date }>)[0].observedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await extractSignals(CLIENT_A);
    const second = (insertedRows[1] as Array<{ observedAt: Date }>)[0].observedAt;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it("does not write a status field, so a suppressed signal is never reopened", async () => {
    seedKeywords();
    await extractSignals(CLIENT_A);
    for (const row of insertedRows[0] as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty("status");
    }
  });
});
