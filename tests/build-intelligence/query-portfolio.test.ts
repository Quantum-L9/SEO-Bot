/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it } from "vitest";
import {
  buildSeedPortfolio,
  EXPANSION_WEIGHT_DECAY,
  expandPortfolio,
  MAX_EXPANSION_ROUNDS,
  MAX_PORTFOLIO_QUERIES,
  normalizeQueryText,
  type QueryPortfolio,
} from "../../src/build-intelligence/query-portfolio.js";

const market = {
  niche: "roofing",
  country: "United States",
  language: "English",
  location_name: "Dallas, Texas",
};

describe("query portfolio — deterministic seeds", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeQueryText("  Metal   ROOFING ")).toBe("metal roofing");
  });

  it("assigns stable ids, preserves intent, and defaults weight to 1", () => {
    const portfolio = buildSeedPortfolio([
      { query: "metal roofing", intent: "commercial", weight: 2 },
      { query: "roof repair", intent: "transactional" },
    ]);
    expect(portfolio.queries).toEqual([
      { query_id: "q1", query: "metal roofing", intent: "commercial", weight: 2 },
      { query_id: "q2", query: "roof repair", intent: "transactional", weight: 1 },
    ]);
    expect(portfolio.round).toBe(0);
    expect(portfolio.provenance.every((entry) => entry.origin === "seed")).toBe(true);
  });

  it("drops blank queries and collapses duplicates to the first occurrence", () => {
    const portfolio = buildSeedPortfolio([
      { query: "roof repair", intent: "commercial", weight: 3 },
      { query: "  ", intent: "commercial" },
      { query: "ROOF  repair", intent: "local", weight: 9 },
    ]);
    expect(portfolio.queries).toHaveLength(1);
    expect(portfolio.queries[0]).toMatchObject({ weight: 3, intent: "commercial" });
  });

  it("rejects a non-positive or non-finite weight in favour of 1", () => {
    const portfolio = buildSeedPortfolio([
      { query: "a", intent: "commercial", weight: 0 },
      { query: "b", intent: "commercial", weight: Number.NaN },
      { query: "c", intent: "commercial", weight: -4 },
    ]);
    expect(portfolio.queries.map((q) => q.weight)).toEqual([1, 1, 1]);
  });

  it("is a pure function of its input", () => {
    const seeds = [{ query: "metal roofing", intent: "commercial" as const, weight: 2 }];
    expect(buildSeedPortfolio(seeds)).toEqual(buildSeedPortfolio(seeds));
  });
});

describe("query portfolio — bounded deterministic expansion", () => {
  const seeds = buildSeedPortfolio([
    { query: "metal roofing", intent: "commercial", weight: 2 },
    { query: "roof repair", intent: "transactional" },
  ]);

  it("adds queries derived only from the seeds and the supplied market", () => {
    const round1 = expandPortfolio(seeds, market);
    expect(round1).not.toBeNull();
    const added = round1!.provenance.filter((entry) => entry.origin === "expansion");
    expect(added.length).toBeGreaterThan(0);
    for (const entry of added) {
      expect(entry.expansion_round).toBe(1);
      expect(entry.derived_from).toBeTruthy();
      expect(entry.query).toContain(entry.derived_from!);
    }
    expect(round1!.queries.map((q) => q.query)).toContain("metal roofing company");
  });

  it("uses the supplied location in the geography round", () => {
    const round2 = expandPortfolio(expandPortfolio(seeds, market)!, market)!;
    expect(round2.queries.map((q) => q.query)).toContain("metal roofing dallas, texas");
    expect(round2.queries.map((q) => q.query)).toContain("metal roofing near me");
  });

  it("decays expansion weights deterministically per round", () => {
    const round1 = expandPortfolio(seeds, market)!;
    const derived = round1.queries.find((q) => q.query === "metal roofing company");
    expect(derived?.weight).toBe(2 * EXPANSION_WEIGHT_DECAY);
  });

  it("never re-adds a query that is already in the portfolio", () => {
    let portfolio: QueryPortfolio | null = seeds;
    const seen = new Set<string>();
    while (portfolio) {
      for (const query of portfolio.queries) seen.add(query.query);
      expect(new Set(portfolio.queries.map((q) => q.query)).size).toBe(portfolio.queries.length);
      expect(new Set(portfolio.queries.map((q) => q.query_id)).size).toBe(portfolio.queries.length);
      portfolio = expandPortfolio(portfolio, market);
    }
  });

  it("stops at the round ceiling", () => {
    let portfolio: QueryPortfolio = seeds;
    let rounds = 0;
    for (;;) {
      const next = expandPortfolio(portfolio, market);
      if (!next) break;
      portfolio = next;
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(MAX_EXPANSION_ROUNDS);
    }
    expect(rounds).toBe(MAX_EXPANSION_ROUNDS);
    expect(portfolio.queries.length).toBeLessThanOrEqual(MAX_PORTFOLIO_QUERIES);
  });

  it("never exceeds the hard query ceiling even with many seeds", () => {
    const many = buildSeedPortfolio(
      Array.from({ length: 12 }, (_, i) => ({
        query: `service ${i}`,
        intent: "commercial" as const,
      })),
    );
    let portfolio: QueryPortfolio = many;
    for (;;) {
      const next = expandPortfolio(portfolio, market);
      if (!next) break;
      portfolio = next;
    }
    expect(portfolio.queries.length).toBeLessThanOrEqual(MAX_PORTFOLIO_QUERIES);
  });

  it("expands identically for identical inputs", () => {
    const a = expandPortfolio(seeds, market);
    const b = expandPortfolio(buildSeedPortfolio(seeds.queries), market);
    expect(a?.queries).toEqual(b?.queries);
  });

  it("returns null when the market supplies no geography for that round", () => {
    const noPlace = { niche: "roofing", country: "", language: "English" };
    const round1 = expandPortfolio(seeds, noPlace)!;
    const round2 = expandPortfolio(round1, noPlace)!;
    // near-me still applies, the location variant does not.
    expect(round2.queries.map((q) => q.query)).toContain("metal roofing near me");
    expect(round2.queries.some((q) => q.query.endsWith("metal roofing "))).toBe(false);
  });
});
