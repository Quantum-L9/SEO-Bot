/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { assertIntelligenceArtifactIntegrity } from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  CompetitiveEvidenceIncompleteError,
  type CompetitiveLandscapeRequest,
  createCompetitiveLandscape,
  type DataForSeoOrganicPort,
  REQUIRED_DONOR_COUNT,
  visibilityContribution,
} from "../../src/build-intelligence/competitive-landscape.js";
import {
  HARD_EXPANSION_CEILING,
  planExpansionRound,
} from "../../src/build-intelligence/query-expansion.js";
import type { OrganicSerpResult } from "../../src/services/dataforseo.js";
import { DataForSeoTaskError, DataForSeoUnavailableError } from "../../src/services/dataforseo.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const executeSpy = vi.fn();
vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({
    execute: executeSpy,
    strategizeJson: executeSpy,
    executePolicyJson: executeSpy,
  }),
}));

function serp(
  keyword: string,
  items: Array<{ rank: number; url: string }>,
  observedAt = "2024-01-01T00:00:00.000Z",
): OrganicSerpResult {
  return {
    keyword,
    locationName: "United States",
    languageName: "English",
    device: "desktop",
    observedAt,
    serpFeatures: [],
    items: items.map((item) => ({
      rankAbsolute: item.rank,
      rankGroup: item.rank,
      url: item.url,
      domain: new URL(item.url).hostname.replace("www.", ""),
      title: "",
      snippet: "",
    })),
    outcome: items.length === 0 ? "valid_empty" : "ok",
  };
}

function companyUrl(index: number, path = "/"): string {
  return `https://www.operating-co-${index}.com${path}`;
}

function rankedCompanies(count: number, startRank = 1): Array<{ rank: number; url: string }> {
  return Array.from({ length: count }, (_, i) => ({
    rank: startRank + i,
    url: companyUrl(i + 1),
  }));
}

class FakePort implements DataForSeoOrganicPort {
  public calls = 0;
  public keywords: string[] = [];
  constructor(
    private readonly map: Record<string, OrganicSerpResult>,
    private readonly failures: Record<string, Error> = {},
  ) {}
  async getOrganicSerp(params: { keyword: string }): Promise<OrganicSerpResult> {
    this.calls += 1;
    this.keywords.push(params.keyword);
    if (this.failures[params.keyword]) throw this.failures[params.keyword];
    return this.map[params.keyword] ?? serp(params.keyword, []);
  }
}

const baseRequest: CompetitiveLandscapeRequest = {
  client_id: "client-1",
  build_id: "build-1",
  market: {
    niche: "roofing",
    country: "United States",
    language: "English",
    device: "desktop",
    location_name: "North Carolina,United States",
  },
  seed_queries: [
    { query: "metal roofing", intent: "commercial", weight: 2 },
    { query: "roof repair", intent: "transactional" },
  ],
};

function visibilityFixture(): Record<string, OrganicSerpResult> {
  return {
    "metal roofing": serp("metal roofing", [
      { rank: 1, url: "https://www.alpha-roofing.com/metal" },
      { rank: 2, url: "https://beta-roofs.com/" },
      { rank: 3, url: "https://www.facebook.com/someroofer" },
      ...rankedCompanies(10, 4),
    ]),
    "roof repair": serp("roof repair", [
      { rank: 1, url: "https://alpha-roofing.com/repair" },
      { rank: 2, url: "https://yelp.com/biz/roofers" },
      { rank: 4, url: "https://gamma-roofing.com/repair" },
    ]),
  };
}

function nCompanyMap(
  n: number,
  extras: Array<{ rank: number; url: string }> = [],
): Record<string, OrganicSerpResult> {
  return {
    "metal roofing": serp("metal roofing", [...rankedCompanies(n), ...extras]),
    "roof repair": serp("roof repair", []),
  };
}

describe("CompetitiveLandscape — deterministic ranking truth", () => {
  it("produces the same semantic digest for the same SERP fixture (determinism)", async () => {
    const a = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    const b = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    expect(a.integrity.payload_digest).toBe(b.integrity.payload_digest);
    expect(a.artifact_id).toBe(b.artifact_id);
    expect(() => assertIntelligenceArtifactIntegrity(a)).not.toThrow();
  });

  it("invokes ZERO LLM operations", async () => {
    await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("records organic-only observations with exact ranking URL, canonical domain, and query id", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    for (const o of artifact.payload.observations) {
      expect(o.source).toBe("dataforseo");
      expect(o.rank).toBeGreaterThanOrEqual(1);
      expect(o.observed_at).toBe("2024-01-01T00:00:00.000Z");
    }
    const alpha = artifact.payload.observations.find(
      (o) => o.url === "https://www.alpha-roofing.com/metal",
    );
    expect(alpha).toBeDefined();
    expect(alpha!.domain).toBe("alpha-roofing.com");
  });

  it("normalizes www/protocol/path variants to one canonical domain (dedupe)", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    const alpha = artifact.payload.domains.find((d) => d.domain === "alpha-roofing.com");
    expect(alpha).toBeDefined();
    expect(alpha!.observation_ids).toHaveLength(2);
    expect(alpha!.qualifying_query_ids.sort()).toEqual(["q1", "q2"]);
  });

  it("computes visibility as Σ weight × 1/log2(rank+1), deterministically", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    const alpha = artifact.payload.domains.find((d) => d.domain === "alpha-roofing.com")!;
    const expected =
      Math.round((visibilityContribution(2, 1) + visibilityContribution(1, 1)) * 1e6) / 1e6;
    expect(alpha.aggregate_visibility).toBe(expected);
  });

  it("does not double-count the same domain twice in one query", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort({
        "metal roofing": serp("metal roofing", [
          { rank: 1, url: "https://www.alpha-roofing.com/a" },
          { rank: 5, url: "https://alpha-roofing.com/b" },
          ...rankedCompanies(10, 6),
        ]),
        "roof repair": serp("roof repair", []),
      }),
    });
    const alpha = artifact.payload.domains.find((d) => d.domain === "alpha-roofing.com")!;
    expect(alpha.observation_ids).toHaveLength(1);
    expect(alpha.aggregate_visibility).toBe(Math.round(visibilityContribution(2, 1) * 1e6) / 1e6);
  });

  it("excludes social/directory domains and operator exclusions, each WITH a reason", async () => {
    const artifact = await createCompetitiveLandscape(
      { ...baseRequest, operator_exclusions: ["gamma-roofing.com"] },
      { dataForSeo: new FakePort(visibilityFixture()) },
    );
    const byDomain = Object.fromEntries(
      artifact.payload.exclusions.map((e) => [e.domain, e.reason]),
    );
    expect(byDomain["facebook.com"]).toBe("social");
    expect(byDomain["yelp.com"]).toBe("directory");
    expect(byDomain["gamma-roofing.com"]).toBe("operator_exclusion");
    const donorDomains = artifact.payload.selected_donors.map((d) => d.domain);
    expect(donorDomains).not.toContain("facebook.com");
    expect(donorDomains).not.toContain("yelp.com");
    expect(donorDomains).not.toContain("gamma-roofing.com");
    expect(donorDomains).toContain("alpha-roofing.com");
  });

  it("guarantees every selected donor resolves to at least one real observation", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(visibilityFixture()),
    });
    const observationIds = new Set(artifact.payload.observations.map((o) => o.observation_id));
    for (const donor of artifact.payload.selected_donors) {
      expect(donor.observation_ids.length).toBeGreaterThanOrEqual(1);
      for (const id of donor.observation_ids) expect(observationIds.has(id)).toBe(true);
    }
  });

  it("breaks visibility ties by first-seen order then domain", async () => {
    const artifact = await createCompetitiveLandscape(
      {
        ...baseRequest,
        seed_queries: [{ query: "metal roofing", intent: "commercial", weight: 1 }],
      },
      {
        dataForSeo: new FakePort({
          "metal roofing": serp("metal roofing", [
            { rank: 1, url: "https://zeta-roof.com/" },
            { rank: 1, url: "https://alpha-roof.com/" },
            ...rankedCompanies(10, 3),
          ]),
        }),
      },
    );
    const firstTwo = artifact.payload.selected_donors.slice(0, 2).map((d) => d.domain);
    expect(firstTwo[0]).toBe("zeta-roof.com");
    expect(firstTwo[1]).toBe("alpha-roof.com");
  });
});

describe("CompetitiveLandscape — exact-10 donor invariant", () => {
  it("fails closed on 3 qualified donors (never seals evidence_complete)", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(nCompanyMap(3)) }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });

  it("fails closed on 9 qualified donors", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(nCompanyMap(9)) }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });

  it("seals exactly 10 qualified donors with evidence_complete=true", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(nCompanyMap(10)),
    });
    expect(artifact.payload.selected_donors).toHaveLength(REQUIRED_DONOR_COUNT);
    expect(artifact.payload.evidence_complete).toBe(true);
    expect(artifact.producer.repo).toBe("SEO-Bot");
  });

  it("replaces a directory occupying a top slot with the next qualified candidate", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(
        nCompanyMap(10, [{ rank: 1, url: "https://www.yelp.com/biz/roofers" }]),
      ),
    });
    const donors = artifact.payload.selected_donors.map((d) => d.domain);
    expect(donors).toHaveLength(10);
    expect(donors).not.toContain("yelp.com");
    expect(artifact.payload.exclusions.some((e) => e.domain === "yelp.com")).toBe(true);
  });

  it("does not count UNKNOWN platform hosts toward the required 10", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new FakePort(
          nCompanyMap(9, [{ rank: 1, url: "https://some-roofer.blogspot.com/post" }]),
        ),
      }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });

  it("replaces an UNKNOWN candidate with the next qualified domain when extras exist", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(
        nCompanyMap(10, [{ rank: 1, url: "https://some-roofer.blogspot.com/post" }]),
      ),
    });
    const donors = artifact.payload.selected_donors.map((d) => d.domain);
    expect(donors).toHaveLength(10);
    expect(donors).not.toContain("blogspot.com");
    expect(donors).not.toContain("some-roofer.blogspot.com");
    expect(
      artifact.payload.exclusions.some(
        (e) => e.reason === "irrelevant" && e.domain.endsWith("blogspot.com"),
      ),
    ).toBe(true);
  });

  it("selects the top deterministic 10 from 12 qualified candidates", async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(nCompanyMap(12)),
    });
    expect(artifact.payload.selected_donors).toHaveLength(10);
    expect(artifact.payload.domains.length).toBeGreaterThanOrEqual(12);
    expect(artifact.payload.selected_donors[0]!.domain).toBe("operating-co-1.com");
  });

  it("does not manufacture donors and ignores a requested count below 10", async () => {
    await expect(
      createCompetitiveLandscape(
        { ...baseRequest, desired_donor_count: 3 },
        { dataForSeo: new FakePort(nCompanyMap(3)) },
      ),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });
});

describe("CompetitiveLandscape — query expansion", () => {
  it("plans a bounded deterministic expansion with provenance", () => {
    const planned = planExpansionRound({
      round: 1,
      niche: "roofing",
      market: { country: "United States", location_name: "North Carolina,United States" },
      existingQueries: ["metal roofing"],
      originalQueries: ["metal roofing"],
      addedSoFar: 0,
    });
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.length).toBeLessThanOrEqual(HARD_EXPANSION_CEILING);
    expect(planned.every((q) => q.round === 1 && q.reason && q.weight === 1)).toBe(true);
    expect(new Set(planned.map((q) => q.query.toLowerCase())).size).toBe(planned.length);
  });

  it("does not emit unbounded or duplicate expansion queries", () => {
    const first = planExpansionRound({
      round: 1,
      niche: "roofing",
      market: { country: "United States" },
      existingQueries: ["roofing", "roofing company"],
      originalQueries: ["roofing"],
      addedSoFar: 0,
    });
    expect(first.every((q) => q.query !== "roofing" && q.query !== "roofing company")).toBe(true);
    const overflow = planExpansionRound({
      round: 1,
      niche: "roofing",
      market: { country: "United States" },
      existingQueries: [],
      originalQueries: ["roofing"],
      addedSoFar: HARD_EXPANSION_CEILING,
    });
    expect(overflow).toEqual([]);
    expect(
      planExpansionRound({
        round: 99,
        niche: "roofing",
        market: { country: "United States" },
        existingQueries: [],
        originalQueries: ["roofing"],
        addedSoFar: 0,
      }),
    ).toEqual([]);
  });

  it("expands the portfolio when the initial queries cannot yield 10 donors", async () => {
    const port = new FakePort({
      "metal roofing": serp("metal roofing", rankedCompanies(4)),
      "roof repair": serp("roof repair", []),
      roofing: serp(
        "roofing",
        rankedCompanies(8, 1).map((item, i) => ({
          rank: item.rank,
          url: companyUrl(20 + i),
        })),
      ),
    });
    const artifact = await createCompetitiveLandscape(baseRequest, { dataForSeo: port });
    expect(artifact.payload.selected_donors).toHaveLength(10);
    expect(artifact.payload.query_portfolio.length).toBeGreaterThan(2);
    expect(port.keywords.some((k) => k !== "metal roofing" && k !== "roof repair")).toBe(true);
  });
});

describe("CompetitiveLandscape — DataForSEO failure surfacing", () => {
  it("does not seal when a query hits a provider failure", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new FakePort(nCompanyMap(10), {
          "roof repair": new DataForSeoUnavailableError("DataForSEO unavailable: network"),
        }),
      }),
    ).rejects.toBeInstanceOf(DataForSeoUnavailableError);
  });

  it("does not degrade a task-level error into zero observations", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new FakePort(nCompanyMap(10), {
          "metal roofing": new DataForSeoTaskError("DataForSEO task error: Invalid Field"),
        }),
      }),
    ).rejects.toBeInstanceOf(DataForSeoTaskError);
  });

  it("treats a valid empty SERP as empty evidence, not a provider success-with-donors", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort({}) }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });
});
