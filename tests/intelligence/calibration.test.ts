/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Score calibration against the action threshold, measured through the REAL
 * extractors.
 *
 * `opportunity-scorer.test.ts` already asserts that "every actionable type
 * clears the default threshold at high severity". It builds those signals by
 * hand, and that is the gap: it proves the SCORER can reach the threshold given
 * a high-severity signal, not that any extractor can produce one.
 *
 * `link_outreach_batch` is what fell through it. Its only feeding extractor
 * capped severity at `medium`, which the type's weights (impact 5, effort 2,
 * risk 3) score at 18 — below the shipped INTELLIGENCE_MIN_OPPORTUNITY_SCORE of
 * 20. So outreach could not be proposed for any input at all, while the
 * outreach allow-flag, the velocity governor, the OUTREACH_FOLLOW_UP_JOBS set
 * and route_safe's explicit promise all guarded a path no signal could take.
 * Every one of those controls tested green, because each tested its own logic
 * rather than whether the road it blocked went anywhere.
 *
 * So this file measures END TO END: an extreme-but-real row, through the real
 * `mapRow`, through the real scorer, compared against the real default. If a
 * type cannot get there, the plane cannot act on it whatever the flags say.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7 }),
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/database/index.js", () => ({ getDb: () => ({}), schema: {} }));

import { PLAN_TEMPLATES } from "../../src/intelligence/action-planner.js";
import { buildOpportunities } from "../../src/intelligence/opportunity-scorer.js";
import {
  citationRateExtractor,
  competitorCitationExtractor,
  keywordDropExtractor,
  lcpRegressionExtractor,
  pageExperienceExtractor,
  prospectReadyExtractor,
} from "../../src/intelligence/signal-extractor.js";
import type { SignalCandidate } from "../../src/intelligence/types.js";

/**
 * The shipped default. Read as a literal rather than through getConfig so the
 * assertion is against what an unconfigured deployment actually uses — an
 * operator who never sets INTELLIGENCE_MIN_OPPORTUNITY_SCORE gets this number.
 */
const DEFAULT_MIN_SCORE = 20;

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

/**
 * The worst case each extractor can legitimately see, expressed as the row its
 * view would return. Extreme, not impossible: a page that lost 60 positions, a
 * citation rate that collapsed from 95% to 1%, 400 contactable prospects.
 *
 * If a type cannot clear the threshold on input THIS bad, no production input
 * will clear it either.
 */
const WORST_CASE: Record<string, () => (SignalCandidate | null)[]> = {
  keyword_recovery: () => [
    keywordDropExtractor.mapRow(
      {
        keyword: "roof repair austin",
        previous_position: "3",
        current_position: "63",
        position_delta: "60",
        url: "https://client.example/roofing",
      },
      CLIENT,
    ),
  ],
  page_experience_repair: () => [
    pageExperienceExtractor.mapRow(
      { page_path: "/roofing", risk_level: "critical", total_pageviews: "100000", exit_rate: 0.94 },
      CLIENT,
    ),
  ],
  performance_regression: () => [
    lcpRegressionExtractor.mapRow(
      {
        page_path: "/roofing",
        current_lcp: "12000",
        baseline_lcp: "900",
        sample_size: "5000",
        baseline_sample_size: "5000",
      },
      CLIENT,
    ),
  ],
  answer_engine_gap: () => [
    citationRateExtractor.mapRow(
      {
        platform: "perplexity",
        current_rate_pct: "1",
        previous_rate_pct: "95",
        queries_checked: "900",
        cited_count: "9",
      },
      CLIENT,
    ),
  ],
  link_outreach_batch: () => [
    prospectReadyExtractor.mapRow(
      {
        prospect_count: "400",
        with_contact: "310",
        best_domain_rating: "92",
        avg_domain_rating: "71.2",
      },
      CLIENT,
    ),
  ],
  keyword_drop_plus_page_experience: () => [
    keywordDropExtractor.mapRow(
      {
        keyword: "roof repair austin",
        position_delta: "60",
        previous_position: "3",
        current_position: "63",
        url: "https://client.example/roofing",
      },
      CLIENT,
    ),
    pageExperienceExtractor.mapRow(
      { page_path: "/roofing", risk_level: "critical", total_pageviews: "100000" },
      CLIENT,
    ),
  ],
  serp_and_answer_engine_loss: () => [
    keywordDropExtractor.mapRow(
      {
        keyword: "roof repair austin",
        previous_position: "3",
        current_position: "63",
        position_delta: "60",
        url: "https://client.example/roofing",
      },
      CLIENT,
    ),
    // The keyword-scoped citation row: the SAME query, losing citations to a
    // competitor, carrying the ranking URL so it groups with the drop above.
    competitorCitationExtractor.mapRow(
      {
        scope: "keyword",
        keyword: "roof repair austin",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "500",
        position_delta: "60",
        url: "https://client.example/roofing",
        sample_queries: ["roof repair austin"],
      },
      CLIENT,
    ),
  ],
};

/**
 * Actionable types that CANNOT be reached, with the reason.
 *
 * Not an exemption — a record. Each entry is a declared remedy the plane can
 * never propose, kept visible here (and in TODO.md) rather than dropped from the
 * loop, so the gap is a fact the suite states rather than a fixture nobody wrote.
 */
const UNREACHABLE: Record<string, string> = {
  // Empty, and kept rather than deleted. `serp_and_answer_engine_loss` was the
  // one entry: its rules need `keyword_drop` and a citation signal in ONE
  // group, and every citation signal keyed on `platform:<name>` while
  // `keyword_drop` keyed on a page or `keyword:<kw>` — dimensions that cannot
  // meet. It is now reachable through the keyword scope of
  // `competitorCitationExtractor`, and has a WORST_CASE fixture above.
  //
  // The record stays because the accounting test below is what makes a gap
  // visible at all: a type with neither a fixture nor a reason here is a type
  // nobody checked.
};

/** Every opportunity type the plane declares a remedy for. */
const ACTIONABLE_TYPES = Object.entries(PLAN_TEMPLATES)
  .filter(([, template]) => template)
  .map(([type]) => type)
  .sort();

/** The ones a real extractor can actually drive to the threshold. */
const REACHABLE_TYPES = ACTIONABLE_TYPES.filter((type) => !(type in UNREACHABLE));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("every actionable opportunity type is reachable through its real extractors", () => {
  it("accounts for every actionable type — with a fixture or with a reason", () => {
    // The fixtures ARE the coverage. A type with neither a fixture nor an entry
    // in UNREACHABLE is a type nobody checked, and the loop below would skip it
    // in silence — which is exactly how link_outreach_batch went unnoticed.
    expect([...Object.keys(WORST_CASE), ...Object.keys(UNREACHABLE)].sort()).toEqual(
      ACTIONABLE_TYPES,
    );
  });

  for (const type of REACHABLE_TYPES) {
    it(`${type}: its extractors produce a signal the scorer rates above the threshold`, () => {
      const signals = WORST_CASE[type]().filter((signal): signal is SignalCandidate =>
        Boolean(signal),
      );

      // First failure mode: the extractor returned null and there is nothing to
      // score. That is a different bug from "scored too low", so it is named.
      expect(signals.length, `no extractor produced a signal for ${type}`).toBeGreaterThan(0);

      const { opportunities } = buildOpportunities(signals);
      const match = opportunities.find((opportunity) => opportunity.opportunityType === type);
      expect(match, `the grouping rules did not classify this input as ${type}`).toBeDefined();

      expect(
        match?.score,
        `${type} tops out at ${match?.score} against a default threshold of ${DEFAULT_MIN_SCORE}. ` +
          `Every gate guarding this remedy is guarding a road that goes nowhere: raise the ` +
          `extractor's severity ceiling, or change the type's weights — do not lower the threshold, ` +
          `which would let every other type through too.`,
      ).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
    });
  }
});

describe("the compound diagnosis, and the join that makes it reachable", () => {
  // This block replaces one that recorded `serp_and_answer_engine_loss` as
  // permanently unreachable. The finding was real: every citation signal keyed
  // on `platform:<name>`, `keyword_drop` keyed on a page or `keyword:<kw>`, and
  // the two rules requiring them together could never match. What the old note
  // got wrong was the cost of fixing it — it said reaching the type "needs the
  // aeo_citations aggregation to carry a keyword or page dimension it does not
  // have". `aeo_citations` has always had a per-row `query`; only the
  // per-platform rollup discarded it. The join needed no migration.
  //
  // The assertions below are on the MECHANISM, not on a score, for the same
  // reason the old ones were: a scoring tweak could make a score-based version
  // of this pass while the two signals still failed to meet.

  const keywordScopedCitation = (over: Record<string, unknown> = {}) =>
    competitorCitationExtractor.mapRow(
      {
        scope: "keyword",
        keyword: "roof repair austin",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "500",
        position_delta: "60",
        url: "https://client.example/roofing",
        sample_queries: ["roof repair austin"],
        ...over,
      },
      CLIENT,
    );

  const platformScopedCitation = () =>
    competitorCitationExtractor.mapRow(
      {
        scope: "platform",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "500",
        sample_queries: ["roof repair austin"],
      },
      CLIENT,
    );

  it("still keys the PLATFORM scope where it always did, which is why the keyword scope exists", () => {
    // Unchanged behavior, asserted so a future edit cannot quietly re-key the
    // platform signal onto a page and take `answer_engine_gap`'s per-platform
    // targeting with it. This is the disjointness the old finding named.
    const citationDrop = citationRateExtractor.mapRow(
      {
        platform: "perplexity",
        current_rate_pct: "1",
        previous_rate_pct: "95",
        queries_checked: "900",
      },
      CLIENT,
    );
    const keywordDrop = keywordDropExtractor.mapRow(
      {
        keyword: "roof repair austin",
        position_delta: "60",
        url: "https://client.example/roofing",
      },
      CLIENT,
    );

    expect(citationDrop?.groupKey).toBe("platform:perplexity");
    expect(platformScopedCitation()?.groupKey).toBe("platform:perplexity");
    expect(keywordDrop?.groupKey).toBe("/roofing");
    for (const citation of [citationDrop, platformScopedCitation()]) {
      expect(citation?.groupKey).not.toBe(keywordDrop?.groupKey);
    }
  });

  it("keys the KEYWORD scope exactly as keyword_drop does, in both its forms", () => {
    // The whole join is this equality. Asserted against `keywordDropExtractor`'s
    // own output rather than against a literal, so the two cannot drift apart.
    const withUrl = keywordDropExtractor.mapRow(
      {
        keyword: "roof repair austin",
        position_delta: "60",
        url: "https://client.example/roofing",
      },
      CLIENT,
    );
    const withoutUrl = keywordDropExtractor.mapRow(
      { keyword: "roof repair austin", position_delta: "60" },
      CLIENT,
    );

    expect(keywordScopedCitation()?.groupKey).toBe(withUrl?.groupKey);
    expect(keywordScopedCitation({ url: null })?.groupKey).toBe(withoutUrl?.groupKey);
    expect(keywordScopedCitation({ url: null })?.groupKey).toBe("keyword:roof repair austin");
  });

  it("gives the two scopes distinct fingerprints, so neither suppresses the other", () => {
    // The fingerprint is (client, signalType, entityId). Both scopes carry the
    // signal type `competitor_citation_gain`, so a shared entityId would make
    // the cooldown treat them as one observation and silently blind whichever
    // arrived second — the compound diagnosis would go back to never firing,
    // with every test above still green.
    expect(keywordScopedCitation()?.fingerprint).not.toBe(platformScopedCitation()?.fingerprint);
    expect(keywordScopedCitation()?.entityType).toBe("keyword");
    expect(platformScopedCitation()?.entityType).toBe("platform");
  });

  it("forms the compound diagnosis from a ranking drop and a citation loss on one keyword", () => {
    const signals = [
      keywordDropExtractor.mapRow(
        {
          keyword: "roof repair austin",
          position_delta: "60",
          url: "https://client.example/roofing",
        },
        CLIENT,
      ),
      keywordScopedCitation(),
    ].filter((signal): signal is SignalCandidate => Boolean(signal));

    const { opportunities } = buildOpportunities(signals);
    expect(opportunities.map((o) => o.opportunityType)).toEqual(["serp_and_answer_engine_loss"]);
    // And it clears the bar, which the WORST_CASE loop also proves. Repeated
    // here because "classified correctly but scored 18" is the exact shape of
    // the failure this whole file exists to catch.
    expect(opportunities[0]?.score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
  });

  it("still produces the two single-symptom diagnoses when the citation loss is platform-wide", () => {
    // Nothing about the join changes what a platform-scoped citation loss means.
    // An operator who had `answer_engine_gap` + `keyword_recovery` before still
    // gets exactly that when the losses are not on the same query.
    const signals = [
      keywordDropExtractor.mapRow(
        { keyword: "roof repair austin", position_delta: "60", url: "https://c.example/roofing" },
        CLIENT,
      ),
      citationRateExtractor.mapRow(
        {
          platform: "perplexity",
          current_rate_pct: "1",
          previous_rate_pct: "95",
          queries_checked: "900",
        },
        CLIENT,
      ),
    ].filter((signal): signal is SignalCandidate => Boolean(signal));

    expect(
      buildOpportunities(signals)
        .opportunities.map((o) => o.opportunityType)
        .sort(),
    ).toEqual(["answer_engine_gap", "keyword_recovery"]);
  });

  it("holds the keyword scope to the same 5-position bar keyword_drop applies", () => {
    // Below that bar there is no `keyword_drop` signal to pair with, so a
    // keyword-scoped citation row would land alone on the page group and be
    // classified `answer_engine_gap` — the same diagnosis the platform row
    // already carries, on a key that hides it from the platform view.
    expect(keywordScopedCitation({ position_delta: "2" })).toBeNull();
    expect(keywordScopedCitation({ position_delta: null })).toBeNull();
    expect(keywordScopedCitation({ position_delta: "5" })).not.toBeNull();
  });

  it("still declares the remedy the diagnosis routes to", () => {
    expect(PLAN_TEMPLATES.serp_and_answer_engine_loss).toBeDefined();
    expect(Object.keys(UNREACHABLE)).not.toContain("serp_and_answer_engine_loss");
  });
});

describe("the outreach type specifically", () => {
  // This is the one that was unreachable, so it gets the direct assertion
  // rather than only the loop's.
  it("clears the threshold once the contactable batch is large", () => {
    const signal = prospectReadyExtractor.mapRow(
      { prospect_count: "400", with_contact: "310", best_domain_rating: "92" },
      CLIENT,
    );
    expect(signal?.severity).toBe("high");
    const [opportunity] = buildOpportunities([signal as SignalCandidate]).opportunities;
    expect(opportunity.opportunityType).toBe("link_outreach_batch");
    expect(opportunity.score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
  });

  it("still rates a mostly-unreachable batch below a reachable one", () => {
    // Severity keys off the contactable subset, not the raw count: 200 domains
    // with no addresses is not a bigger opportunity than 30 with them.
    const unreachable = prospectReadyExtractor.mapRow(
      { prospect_count: "200", with_contact: "2", best_domain_rating: "92" },
      CLIENT,
    );
    const reachable = prospectReadyExtractor.mapRow(
      { prospect_count: "30", with_contact: "25", best_domain_rating: "92" },
      CLIENT,
    );
    expect(unreachable?.severity).toBe("medium");
    expect(reachable?.severity).toBe("high");
  });

  it("is still no opportunity at all when nobody can be contacted", () => {
    expect(
      prospectReadyExtractor.mapRow(
        { prospect_count: "400", with_contact: "0", best_domain_rating: "92" },
        CLIENT,
      ),
    ).toBeNull();
  });
});

describe("the threshold itself", () => {
  it("matches the default the config schema ships", async () => {
    // Guards the constant above: if the shipped default moves, this file is
    // measuring against a number nobody uses any more.
    const { readFileSync } = await import("node:fs");
    const config = readFileSync("src/core/config.ts", "utf8");
    const declared = config.match(
      /INTELLIGENCE_MIN_OPPORTUNITY_SCORE:[\s\S]{0,120}?\.default\((\d+)\)/,
    );
    expect(declared?.[1]).toBe(String(DEFAULT_MIN_SCORE));
  });
});
