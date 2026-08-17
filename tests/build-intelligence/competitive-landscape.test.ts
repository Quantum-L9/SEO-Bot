/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { assertIntelligenceArtifactIntegrity } from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  CompetitiveDonorQualificationError,
  CompetitiveEvidenceIncompleteError,
  type CompetitiveLandscapeRequest,
  createCompetitiveLandscape,
  type DataForSeoOrganicPort,
} from "../../src/build-intelligence/competitive-landscape.js";
import { MAX_PORTFOLIO_QUERIES } from "../../src/build-intelligence/query-portfolio.js";
import {
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  type OrganicSerpResult,
  SerpEvidenceInvalidError,
} from "../../src/services/dataforseo.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Zero-LLM guard: the LLM service module is mocked so any accidental use would
// register a call. It must never be touched on the CompetitiveLandscape path.
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
  };
}

class FakePort implements DataForSeoOrganicPort {
  public readonly keywords: string[] = [];
  constructor(
    private readonly map: Record<string, OrganicSerpResult>,
    private readonly fallback: (keyword: string) => OrganicSerpResult = (keyword) =>
      serp(keyword, []),
  ) {}
  async getOrganicSerp(params: { keyword: string }): Promise<OrganicSerpResult> {
    this.keywords.push(params.keyword);
    return this.map[params.keyword] ?? this.fallback(params.keyword);
  }
}

/** Emits N qualifying operating-company domains for every query it is asked about. */
function cohortPort(companyCount: number, extras: Array<{ rank: number; url: string }> = []) {
  return new FakePort({}, (keyword) =>
    serp(keyword, [
      ...Array.from({ length: companyCount }, (_, i) => ({
        rank: i + 1,
        url: `https://co-${String(i + 1).padStart(2, "0")}.com/${encodeURIComponent(keyword)}`,
      })),
      ...extras,
    ]),
  );
}

const baseRequest: CompetitiveLandscapeRequest = {
  client_id: "client-1",
  build_id: "build-1",
  market: { niche: "roofing", country: "United States", language: "English", device: "desktop" },
  seed_queries: [
    { query: "metal roofing", intent: "commercial", weight: 2 },
    { query: "roof repair", intent: "transactional" },
  ],
  desired_donor_count: 3,
};

function fixtureMap(): Record<string, OrganicSerpResult> {
  return {
    "metal roofing": serp("metal roofing", [
      { rank: 1, url: "https://www.alpha-roofing.com/metal" },
      { rank: 2, url: "https://beta-roofs.com/" },
      { rank: 3, url: "https://www.facebook.com/someroofer" },
    ]),
    "roof repair": serp("roof repair", [
      { rank: 1, url: "https://alpha-roofing.com/repair" }, // same domain as www.alpha-roofing.com
      { rank: 2, url: "https://yelp.com/biz/roofers" },
      { rank: 4, url: "https://gamma-roofing.com/repair" },
    ]),
  };
}

describe("CompetitiveLandscape — deterministic ranking truth", () => {
  it("produces the same semantic digest for the same SERP fixture (determinism)", async () => {
    const a = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    const b = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    expect(a.artifact.integrity.payload_digest).toBe(b.artifact.integrity.payload_digest);
    expect(a.artifact.artifact_id).toBe(b.artifact.artifact_id);
    expect(() => assertIntelligenceArtifactIntegrity(a.artifact)).not.toThrow();
  });

  it("invokes ZERO LLM operations and reports ranking_llm_calls=0", async () => {
    const { evidence } = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(evidence.ranking_llm_calls).toBe(0);
  });

  it("records organic-only observations with exact ranking URL, canonical domain, and query id", async () => {
    const { artifact } = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    for (const o of artifact.payload.observations) {
      expect(o.source).toBe("dataforseo");
      expect(o.rank).toBeGreaterThanOrEqual(1);
      expect(o.observed_at).toBe("2024-01-01T00:00:00.000Z");
      expect(o.query_id).toMatch(/^q\d+$/);
    }
    const alpha = artifact.payload.observations.find(
      (o) => o.url === "https://www.alpha-roofing.com/metal",
    );
    expect(alpha).toBeDefined();
    expect(alpha?.domain).toBe("alpha-roofing.com");
  });

  it("assigns collision-free observation ids even when two items share a rank", async () => {
    const port = new FakePort({
      "metal roofing": serp("metal roofing", [
        { rank: 1, url: "https://one.com/a" },
        { rank: 1, url: "https://two.com/b" }, // duplicate rank_group — must not collide
        { rank: 2, url: "https://three.com/c" },
      ]),
      "roof repair": serp("roof repair", [{ rank: 1, url: "https://one.com/r" }]),
    });
    const { artifact } = await createCompetitiveLandscape(baseRequest, { dataForSeo: port });
    const ids = artifact.payload.observations.map((o) => o.observation_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not double-count the identical ranking URL within one query", async () => {
    const port = new FakePort({
      "metal roofing": serp("metal roofing", [
        { rank: 1, url: "https://dup.com/page" },
        { rank: 5, url: "https://dup.com/page" }, // same URL repeated
        { rank: 2, url: "https://other.com/x" },
      ]),
      "roof repair": serp("roof repair", [{ rank: 1, url: "https://dup.com/r" }]),
    });
    const { artifact } = await createCompetitiveLandscape(
      { ...baseRequest, desired_donor_count: 2 },
      { dataForSeo: port },
    );
    const dup = artifact.payload.domains.find((d) => d.domain === "dup.com");
    // q1 contributes exactly one observation for the repeated URL, q2 one more.
    expect(dup?.observation_ids).toHaveLength(2);
  });

  it("normalizes www/protocol/path variants to one canonical domain (dedupe)", async () => {
    const { artifact } = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    const alpha = artifact.payload.domains.find((d) => d.domain === "alpha-roofing.com");
    expect(alpha).toBeDefined();
    expect(alpha?.observation_ids).toHaveLength(2);
    expect(alpha?.qualifying_query_ids.slice().sort()).toEqual(["q1", "q2"]);
  });

  it("computes visibility as Σ weight × 1/log2(rank+1), deterministically", async () => {
    const { artifact } = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    const alpha = artifact.payload.domains.find((d) => d.domain === "alpha-roofing.com");
    // q1 weight 2 @ rank1: 2 * 1/log2(2) = 2 ; q2 weight 1 @ rank1: 1 * 1/log2(2) = 1
    const expected = Math.round((2 * (1 / Math.log2(2)) + 1 * (1 / Math.log2(2))) * 1e6) / 1e6;
    expect(alpha?.aggregate_visibility).toBe(expected);
  });

  it("breaks visibility ties deterministically and reproducibly", async () => {
    const tied = new FakePort({
      "metal roofing": serp("metal roofing", [
        { rank: 1, url: "https://zeta.com/a" },
        { rank: 1, url: "https://alpha.com/a" },
        { rank: 1, url: "https://mid.com/a" },
      ]),
      "roof repair": serp("roof repair", []),
    });
    const first = await createCompetitiveLandscape(baseRequest, { dataForSeo: tied });
    const second = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort({
        "metal roofing": serp("metal roofing", [
          { rank: 1, url: "https://zeta.com/a" },
          { rank: 1, url: "https://alpha.com/a" },
          { rank: 1, url: "https://mid.com/a" },
        ]),
        "roof repair": serp("roof repair", []),
      }),
    });
    const order = first.artifact.payload.selected_donors.map((d) => d.domain);
    expect(order).toEqual(second.artifact.payload.selected_donors.map((d) => d.domain));
    // Equal visibility → first-seen order wins, so SERP order is preserved.
    expect(order).toEqual(["zeta.com", "alpha.com", "mid.com"]);
  });

  it("excludes social/directory domains and operator exclusions, each WITH a reason", async () => {
    const { artifact } = await createCompetitiveLandscape(
      { ...baseRequest, desired_donor_count: 2, operator_exclusions: ["gamma-roofing.com"] },
      { dataForSeo: new FakePort(fixtureMap()) },
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
    const { artifact } = await createCompetitiveLandscape(baseRequest, {
      dataForSeo: new FakePort(fixtureMap()),
    });
    const observationIds = new Set(artifact.payload.observations.map((o) => o.observation_id));
    for (const donor of artifact.payload.selected_donors) {
      expect(donor.observation_ids.length).toBeGreaterThanOrEqual(1);
      for (const id of donor.observation_ids) expect(observationIds.has(id)).toBe(true);
    }
  });
});

describe("CompetitiveLandscape — the exactly-ten donor invariant", () => {
  const tenRequest: CompetitiveLandscapeRequest = { ...baseRequest, desired_donor_count: 10 };

  it("seals with evidence_complete=true when exactly 10 qualified donors exist", async () => {
    const { artifact, evidence } = await createCompetitiveLandscape(tenRequest, {
      dataForSeo: cohortPort(10),
    });
    expect(artifact.payload.selected_donors).toHaveLength(10);
    expect(artifact.payload.evidence_complete).toBe(true);
    expect(evidence.selected_donor_count).toBe(10);
  });

  it("selects the deterministic top 10 when 12 qualify", async () => {
    const { artifact } = await createCompetitiveLandscape(tenRequest, {
      dataForSeo: cohortPort(12),
    });
    expect(artifact.payload.selected_donors).toHaveLength(10);
    // Rank 1 is the strongest, rank 12 the weakest — the tail is dropped.
    expect(artifact.payload.selected_donors.map((d) => d.domain)).toEqual(
      Array.from({ length: 10 }, (_, i) => `co-${String(i + 1).padStart(2, "0")}.com`),
    );
  });

  it("REJECTS a 3-donor cohort instead of sealing it", async () => {
    await expect(
      createCompetitiveLandscape(tenRequest, { dataForSeo: cohortPort(3) }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_EVIDENCE_INCOMPLETE" });
  });

  it("REJECTS a 9-donor cohort instead of sealing it", async () => {
    await expect(
      createCompetitiveLandscape(tenRequest, { dataForSeo: cohortPort(9) }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_EVIDENCE_INCOMPLETE" });
  });

  it("never emits evidence_complete=true for a short cohort (no partial seal path)", async () => {
    for (const count of [0, 1, 3, 7, 9]) {
      await expect(
        createCompetitiveLandscape(tenRequest, { dataForSeo: cohortPort(count) }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it("replaces an excluded directory with the next qualified candidate", async () => {
    // 10 companies + a directory ranked 2nd: the directory must not take a slot,
    // so the cohort falls one short and fails closed.
    await expect(
      createCompetitiveLandscape(tenRequest, {
        dataForSeo: cohortPort(9, [{ rank: 2, url: "https://yelp.com/biz" }]),
      }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_DONOR_QUALIFICATION_FAILED" });

    // With an 11th real company available the directory is simply skipped over.
    const { artifact } = await createCompetitiveLandscape(tenRequest, {
      dataForSeo: cohortPort(11, [{ rank: 2, url: "https://yelp.com/biz" }]),
    });
    expect(artifact.payload.selected_donors).toHaveLength(10);
    expect(artifact.payload.selected_donors.map((d) => d.domain)).not.toContain("yelp.com");
    expect(artifact.payload.exclusions.map((e) => e.domain)).toContain("yelp.com");
  });

  it("never counts an UNKNOWN (uncorroborated) domain toward the cohort", async () => {
    // 9 corroborated companies plus one domain seen once at rank 15 → UNKNOWN.
    await expect(
      createCompetitiveLandscape(tenRequest, {
        dataForSeo: new FakePort({}, (keyword) =>
          keyword === "metal roofing"
            ? serp(keyword, [
                ...Array.from({ length: 9 }, (_, i) => ({
                  rank: i + 1,
                  url: `https://co-${i}.com/x`,
                })),
                { rank: 15, url: "https://mystery-domain.com/deep" },
              ])
            : serp(keyword, []),
        ),
      }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_DONOR_QUALIFICATION_FAILED" });
  });

  it("records an UNKNOWN candidate in the ledger as irrelevant, never as qualified", async () => {
    // Seen for exactly one query, deep in the results: no corroboration.
    const { artifact, evidence } = await createCompetitiveLandscape(tenRequest, {
      dataForSeo: new FakePort({}, (keyword) =>
        serp(keyword, [
          ...Array.from({ length: 10 }, (_, i) => ({
            rank: i + 1,
            url: `https://co-${String(i + 1).padStart(2, "0")}.com/x`,
          })),
          ...(keyword === "metal roofing"
            ? [{ rank: 18, url: "https://mystery-domain.com/deep" }]
            : []),
        ]),
      ),
    });
    const mystery = evidence.qualification_ledger.find(
      (entry) => entry.domain === "mystery-domain.com",
    );
    expect(mystery?.status).toBe("unknown");
    expect(mystery?.rule).toBe("insufficient_market_corroboration");
    expect(artifact.payload.exclusions).toContainEqual({
      domain: "mystery-domain.com",
      reason: "irrelevant",
    });
    expect(artifact.payload.selected_donors.map((d) => d.domain)).not.toContain(
      "mystery-domain.com",
    );
  });
});

describe("CompetitiveLandscape — bounded deterministic query expansion", () => {
  const tenRequest: CompetitiveLandscapeRequest = { ...baseRequest, desired_donor_count: 10 };

  it("does not expand when the seed portfolio already satisfies the cohort", async () => {
    const port = cohortPort(10);
    const { evidence } = await createCompetitiveLandscape(tenRequest, { dataForSeo: port });
    expect(evidence.expansion_rounds_used).toBe(0);
    expect(evidence.final_query_count).toBe(evidence.seed_query_count);
    expect(port.keywords).toEqual(["metal roofing", "roof repair"]);
  });

  it("expands deterministically and records provenance for every added query", async () => {
    // Seeds yield only 5 companies; expansion queries surface the rest.
    const port = new FakePort({}, (keyword) =>
      ["metal roofing", "roof repair"].includes(keyword)
        ? serp(
            keyword,
            Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, url: `https://co-${i}.com/x` })),
          )
        : serp(
            keyword,
            Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, url: `https://co-${i}.com/x` })),
          ),
    );
    const { artifact, evidence } = await createCompetitiveLandscape(tenRequest, {
      dataForSeo: port,
    });
    expect(evidence.expansion_rounds_used).toBeGreaterThanOrEqual(1);
    expect(evidence.final_query_count).toBeGreaterThan(evidence.seed_query_count);
    expect(artifact.payload.selected_donors).toHaveLength(10);

    const expanded = evidence.query_provenance.filter((entry) => entry.origin === "expansion");
    expect(expanded.length).toBeGreaterThan(0);
    for (const entry of expanded) {
      expect(entry.rule).toBeTruthy();
      expect(entry.expansion_round).toBeGreaterThanOrEqual(1);
      expect(entry.derived_from).toBeTruthy();
    }
    // Every portfolio query is present in the sealed artifact.
    expect(artifact.payload.query_portfolio).toHaveLength(evidence.final_query_count);
  });

  it("honors the hard expansion ceiling and then fails closed", async () => {
    const port = cohortPort(4);
    await expect(
      createCompetitiveLandscape(tenRequest, { dataForSeo: port }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_EVIDENCE_INCOMPLETE" });
    // Expansion ran, but never beyond the hard query ceiling.
    expect(port.keywords.length).toBeGreaterThan(tenRequest.seed_queries.length);
    expect(port.keywords.length).toBeLessThanOrEqual(MAX_PORTFOLIO_QUERIES);
  });

  it("fetches each portfolio query exactly once across expansion rounds", async () => {
    const port = cohortPort(4);
    await createCompetitiveLandscape(tenRequest, { dataForSeo: port }).catch(() => undefined);
    expect(new Set(port.keywords).size).toBe(port.keywords.length);
  });
});

describe("CompetitiveLandscape — SERP evidence integrity", () => {
  class ThrowingPort implements DataForSeoOrganicPort {
    constructor(
      private readonly error: Error,
      private readonly failOn?: string,
    ) {}
    async getOrganicSerp(params: { keyword: string }): Promise<OrganicSerpResult> {
      if (!this.failOn || params.keyword === this.failOn) throw this.error;
      return serp(params.keyword, [{ rank: 1, url: "https://ok.com/a" }]);
    }
  }

  it("surfaces a provider outage rather than degrading to zero observations", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new ThrowingPort(new DataForSeoUnavailableError("connect ETIMEDOUT")),
      }),
    ).rejects.toBeInstanceOf(DataForSeoUnavailableError);
  });

  it("surfaces a task-level provider error rather than an empty landscape", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new ThrowingPort(new DataForSeoTaskError("invalid location_name")),
      }),
    ).rejects.toBeInstanceOf(DataForSeoTaskError);
  });

  it("surfaces malformed SERP evidence rather than silently skipping it", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new ThrowingPort(new SerpEvidenceInvalidError("item has no usable rank")),
      }),
    ).rejects.toBeInstanceOf(SerpEvidenceInvalidError);
  });

  it("fails the whole artifact when only ONE query fails (no partial evidence)", async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, {
        dataForSeo: new ThrowingPort(new DataForSeoTaskError("quota"), "roof repair"),
      }),
    ).rejects.toBeInstanceOf(DataForSeoTaskError);
  });

  it("treats a genuinely empty SERP as a valid empty result, not a failure", async () => {
    // Empty results are legal; they simply cannot form a cohort, so the donor
    // invariant (not a provider error) is what fails.
    await expect(
      createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort({}) }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });

  it("distinguishes thin evidence from failed qualification", async () => {
    await expect(
      createCompetitiveLandscape(
        { ...baseRequest, desired_donor_count: 10 },
        { dataForSeo: cohortPort(2) },
      ),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
    await expect(
      createCompetitiveLandscape(
        { ...baseRequest, desired_donor_count: 10 },
        { dataForSeo: cohortPort(11, [{ rank: 1, url: "https://yelp.com/a" }]) },
      ),
    ).resolves.toBeDefined();
    await expect(
      createCompetitiveLandscape(
        { ...baseRequest, desired_donor_count: 10 },
        {
          dataForSeo: cohortPort(5, [
            { rank: 11, url: "https://facebook.com/a" },
            { rank: 12, url: "https://yelp.com/a" },
            { rank: 13, url: "https://reddit.com/a" },
            { rank: 14, url: "https://amazon.com/a" },
            { rank: 15, url: "https://forbes.com/a" },
            { rank: 16, url: "https://trustpilot.com/a" },
          ]),
        },
      ),
    ).rejects.toBeInstanceOf(CompetitiveDonorQualificationError);
  });

  it("rejects a request whose seed queries are all blank", async () => {
    await expect(
      createCompetitiveLandscape(
        { ...baseRequest, seed_queries: [{ query: "   ", intent: "commercial" }] },
        { dataForSeo: new FakePort({}) },
      ),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });
});
