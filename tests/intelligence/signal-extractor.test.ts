/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Extractors have a SQL half and a judgment half. The judgment half — severity
 * thresholds, confidence, the grouping key — is what decides whether a page
 * problem and a ranking problem ever meet, so it is tested directly against the
 * row shapes the queries return.
 *
 * Coercion is tested too, because pg returns numeric and bigint as STRINGS: an
 * extractor that compared `"12" >= 5` would classify every row as low severity
 * and nothing would look broken.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/database/index.js", () => ({ getDb: () => ({}), schema: {} }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  allExtractors,
  applySuppression,
  asNumber,
  asString,
  citationRateExtractor,
  competitorCitationExtractor,
  jobFailureExtractor,
  keywordDropExtractor,
  lcpRegressionExtractor,
  llmBudgetExtractor,
  pageExperienceExtractor,
  prospectReadyExtractor,
  STATIC_EXTRACTORS,
} from "../../src/intelligence/signal-extractor.js";
import { SIGNAL_TYPES, type SignalCandidate } from "../../src/intelligence/types.js";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

describe("row coercion", () => {
  it("parses the numeric strings pg returns", () => {
    // pg sends numeric/bigint as text to protect precision.
    expect(asNumber("12")).toBe(12);
    expect(asNumber("3.14")).toBe(3.14);
    expect(asNumber(7)).toBe(7);
  });

  it("returns null rather than NaN for unusable values", () => {
    for (const value of [
      null,
      undefined,
      "",
      "  ",
      "abc",
      {},
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(asNumber(value), String(value)).toBeNull();
    }
  });

  it("returns null for blank strings so a signal is never keyed on nothing", () => {
    expect(asString("")).toBeNull();
    expect(asString("   ")).toBeNull();
    expect(asString("ok")).toBe("ok");
    expect(asString(3)).toBe("3");
  });
});

describe("keywordDropExtractor", () => {
  it("groups on the ranking page so it can meet a page-experience signal", () => {
    const signal = keywordDropExtractor.mapRow(
      {
        keyword: "roofing austin",
        device: "desktop",
        previous_position: "4",
        current_position: "11",
        position_delta: "7",
        url: "https://client.example/roofing?utm=x",
        checked_at: "2026-08-30T06:00:00Z",
      },
      CLIENT,
    );

    expect(signal?.groupKey).toBe("/roofing");
    expect(signal?.evidence.page_path).toBe("/roofing");
    expect(signal?.entityId).toBe("roofing austin");
  });

  it("falls back to a keyword-scoped group when the ranking URL is unknown", () => {
    const signal = keywordDropExtractor.mapRow(
      { keyword: "roofing austin", position_delta: "6", url: null },
      CLIENT,
    );
    expect(signal?.groupKey).toBe("keyword:roofing austin");
  });

  it("escalates severity with the size of the drop", () => {
    const medium = keywordDropExtractor.mapRow({ keyword: "k", position_delta: "6" }, CLIENT);
    const high = keywordDropExtractor.mapRow({ keyword: "k", position_delta: "14" }, CLIENT);
    expect(medium?.severity).toBe("medium");
    expect(high?.severity).toBe("high");
  });

  it("drops a row that does not clear the threshold or lacks a keyword", () => {
    expect(keywordDropExtractor.mapRow({ keyword: "k", position_delta: "2" }, CLIENT)).toBeNull();
    expect(keywordDropExtractor.mapRow({ keyword: null, position_delta: "9" }, CLIENT)).toBeNull();
  });
});

describe("pageExperienceExtractor", () => {
  it("scales confidence with traffic, not with how bad the numbers look", () => {
    // A 74% exit rate across three sessions is noise; across 500 it is a pattern.
    const thin = pageExperienceExtractor.mapRow(
      { page_path: "/x", risk_level: "critical", total_pageviews: "3" },
      CLIENT,
    );
    const solid = pageExperienceExtractor.mapRow(
      { page_path: "/x", risk_level: "critical", total_pageviews: "500" },
      CLIENT,
    );
    expect(thin?.confidence).toBeLessThan(solid?.confidence ?? 0);
    expect(solid?.confidence).toBe(0.9);
  });

  it("maps the view's risk band onto signal severity", () => {
    expect(
      pageExperienceExtractor.mapRow({ page_path: "/x", risk_level: "critical" }, CLIENT)?.severity,
    ).toBe("critical");
    expect(
      pageExperienceExtractor.mapRow({ page_path: "/x", risk_level: "high" }, CLIENT)?.severity,
    ).toBe("high");
  });

  it("normalizes the page path so it shares a group key with a keyword signal", () => {
    const page = pageExperienceExtractor.mapRow(
      { page_path: "/roofing/", risk_level: "high" },
      CLIENT,
    );
    const keyword = keywordDropExtractor.mapRow(
      { keyword: "roofing austin", position_delta: "8", url: "https://client.example/roofing" },
      CLIENT,
    );
    expect(page?.groupKey).toBe(keyword?.groupKey);
  });
});

describe("lcpRegressionExtractor", () => {
  it("records the regression ratio it judged on", () => {
    const signal = lcpRegressionExtractor.mapRow(
      {
        page_path: "/x",
        device: "mobile",
        current_lcp: "4200",
        baseline_lcp: "2800",
        samples: "12",
      },
      CLIENT,
    );
    expect(signal?.evidence.regression_ratio).toBe(1.5);
    expect(signal?.severity).toBe("high");
    expect(signal?.confidence).toBe(0.85);
  });

  it("is less confident on a thin baseline", () => {
    const signal = lcpRegressionExtractor.mapRow(
      { page_path: "/x", current_lcp: "4200", baseline_lcp: "3000", samples: "4" },
      CLIENT,
    );
    expect(signal?.confidence).toBe(0.65);
    expect(signal?.severity).toBe("medium");
  });

  it("refuses to divide by a zero or missing baseline", () => {
    expect(
      lcpRegressionExtractor.mapRow(
        { page_path: "/x", current_lcp: "4200", baseline_lcp: "0" },
        CLIENT,
      ),
    ).toBeNull();
    expect(
      lcpRegressionExtractor.mapRow({ page_path: "/x", current_lcp: "4200" }, CLIENT),
    ).toBeNull();
  });
});

describe("citationRateExtractor", () => {
  it("reports the drop in percentage points and groups by platform", () => {
    const signal = citationRateExtractor.mapRow(
      {
        platform: "perplexity",
        current_rate_pct: "20",
        previous_rate_pct: "55",
        queries_checked: "12",
      },
      CLIENT,
    );
    expect(signal?.evidence.drop_points).toBe(35);
    expect(signal?.severity).toBe("high");
    expect(signal?.groupKey).toBe("platform:perplexity");
  });

  it("is less confident on few sampled queries", () => {
    const signal = citationRateExtractor.mapRow(
      {
        platform: "chatgpt",
        current_rate_pct: "10",
        previous_rate_pct: "30",
        queries_checked: "4",
      },
      CLIENT,
    );
    expect(signal?.confidence).toBe(0.6);
  });
});

describe("competitorCitationExtractor", () => {
  it("shares a group key with the citation-rate signal for the same platform", () => {
    const competitor = competitorCitationExtractor.mapRow(
      { platform: "perplexity", competitor_cited: "rival.example", occurrences: "6" },
      CLIENT,
    );
    const rate = citationRateExtractor.mapRow(
      { platform: "perplexity", current_rate_pct: "10", previous_rate_pct: "40" },
      CLIENT,
    );
    expect(competitor?.groupKey).toBe(rate?.groupKey);
    expect(competitor?.severity).toBe("high");
  });

  it("ignores a single occurrence", () => {
    expect(
      competitorCitationExtractor.mapRow(
        { platform: "perplexity", competitor_cited: "rival.example", occurrences: "1" },
        CLIENT,
      ),
    ).toBeNull();
  });

  it("emits the platform scope when a row carries the scope column explicitly", () => {
    // Production rows always carry `scope`; the tests above omit it and take the
    // same branch by default. Assert the explicit form too, so the default is a
    // convenience rather than the only path anything exercises.
    const signal = competitorCitationExtractor.mapRow(
      {
        scope: "platform",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "6",
        sample_queries: ["roof repair austin", "roofer austin"],
      },
      CLIENT,
    );
    expect(signal?.groupKey).toBe("platform:perplexity");
    expect(signal?.entityId).toBe("perplexity:rival.example");
    expect(signal?.evidence.scope).toBe("platform");
    expect(signal?.evidence.sample_queries).toEqual(["roof repair austin", "roofer austin"]);
  });

  it("emits the keyword scope onto the ranking page, carrying the drop it was joined to", () => {
    const signal = competitorCitationExtractor.mapRow(
      {
        scope: "keyword",
        keyword: "roof repair austin",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "6",
        position_delta: "12",
        url: "https://client.example/roofing?utm=x",
        sample_queries: ["roof repair austin"],
      },
      CLIENT,
    );
    expect(signal?.groupKey).toBe("/roofing");
    expect(signal?.entityType).toBe("keyword");
    expect(signal?.evidence.position_delta).toBe(12);
    expect(signal?.evidence.keyword).toBe("roof repair austin");
  });

  it("falls back to the platform scope when a keyword row has no keyword", () => {
    // Defensive: a `scope='keyword'` row with a null keyword would otherwise
    // build a groupKey of `keyword:null` and quietly invent a group.
    const signal = competitorCitationExtractor.mapRow(
      {
        scope: "keyword",
        platform: "perplexity",
        competitor_cited: "rival.example",
        occurrences: "6",
      },
      CLIENT,
    );
    expect(signal?.groupKey).toBe("platform:perplexity");
  });
});

describe("prospectReadyExtractor", () => {
  it("ignores prospects nobody can actually contact", () => {
    // Outreach on a list with no email addresses is not an opportunity.
    expect(
      prospectReadyExtractor.mapRow(
        { prospect_count: "40", with_contact: "0", best_domain_rating: "80" },
        CLIENT,
      ),
    ).toBeNull();
  });

  it("ignores a batch too small to be worth a run", () => {
    expect(
      prospectReadyExtractor.mapRow({ prospect_count: "2", with_contact: "2" }, CLIENT),
    ).toBeNull();
  });

  it("reports the contactable subset separately from the total", () => {
    const signal = prospectReadyExtractor.mapRow(
      {
        prospect_count: "25",
        with_contact: "9",
        best_domain_rating: "72",
        avg_domain_rating: "51.5",
      },
      CLIENT,
    );
    expect(signal?.evidence).toMatchObject({ prospect_count: 25, contactable_count: 9 });
    expect(signal?.severity).toBe("medium");
  });
});

describe("llmBudgetExtractor", () => {
  const extractor = llmBudgetExtractor(200);

  it("stays quiet below 80% utilization", () => {
    expect(extractor.mapRow({ spend_usd: "120" }, CLIENT)).toBeNull();
  });

  it("escalates as the budget is consumed", () => {
    expect(extractor.mapRow({ spend_usd: "165" }, CLIENT)?.severity).toBe("medium");
    expect(extractor.mapRow({ spend_usd: "185" }, CLIENT)?.severity).toBe("high");
    expect(extractor.mapRow({ spend_usd: "210" }, CLIENT)?.severity).toBe("critical");
  });

  it("reports utilization alongside the raw figures", () => {
    const signal = extractor.mapRow({ spend_usd: "180", call_count: "412" }, CLIENT);
    expect(signal?.evidence).toMatchObject({
      spend_usd: 180,
      monthly_budget_usd: 200,
      utilization: 0.9,
    });
  });

  it("cannot divide by a zero budget", () => {
    expect(llmBudgetExtractor(0).mapRow({ spend_usd: "10" }, CLIENT)).toBeNull();
  });
});

describe("jobFailureExtractor", () => {
  it("escalates with repeat count and names the staleness risk", () => {
    expect(
      jobFailureExtractor.mapRow({ job_name: "j", failure_count: "2" }, CLIENT)?.severity,
    ).toBe("medium");
    expect(
      jobFailureExtractor.mapRow({ job_name: "j", failure_count: "3" }, CLIENT)?.severity,
    ).toBe("high");
    const critical = jobFailureExtractor.mapRow({ job_name: "j", failure_count: "6" }, CLIENT);
    expect(critical?.severity).toBe("critical");
    expect(String(critical?.evidence.impact)).toMatch(/stale/i);
  });

  it("ignores a single failure", () => {
    expect(jobFailureExtractor.mapRow({ job_name: "j", failure_count: "1" }, CLIENT)).toBeNull();
  });
});

describe("extractor registry", () => {
  it("covers every declared signal type exactly once", () => {
    const covered = allExtractors(200).map((extractor) => extractor.signalType);
    expect([...covered].sort()).toEqual([...SIGNAL_TYPES].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("keeps the budget extractor out of the static list, since it needs config", () => {
    expect(STATIC_EXTRACTORS.map((e) => e.signalType)).not.toContain("llm_budget_pressure");
  });

  it("scopes every query to a single tenant", () => {
    // Multi-tenancy is a hard invariant (AGENTS §7): an extractor missing its
    // client filter would leak one client's data into another's signals.
    for (const extractor of allExtractors(200)) {
      const chunks = JSON.stringify(extractor.query(CLIENT));
      expect(chunks, extractor.signalType).toContain(CLIENT);
    }
  });
});

describe("applySuppression", () => {
  function signal(fingerprint: string, severity: SignalCandidate["severity"]): SignalCandidate {
    return {
      clientId: CLIENT,
      entityType: "page",
      entityId: "/x",
      signalType: "high_exit_bad_lcp",
      severity,
      confidence: 0.8,
      evidence: {},
      fingerprint,
      groupKey: "/x",
    };
  }

  it("drops a fingerprint already seen inside the cooldown", () => {
    const { kept, suppressed } = applySuppression(
      [signal("seen", "high"), signal("fresh", "high")],
      new Set(["seen"]),
    );
    expect(kept.map((s) => s.fingerprint)).toEqual(["fresh"]);
    expect(suppressed.map((s) => s.fingerprint)).toEqual(["seen"]);
  });

  it("never suppresses a critical finding", () => {
    // "We already told you" is not a reason to stop reporting something that is
    // still critical.
    const { kept, suppressed } = applySuppression([signal("seen", "critical")], new Set(["seen"]));
    expect(kept).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  it("keeps everything when nothing has been seen", () => {
    const { kept } = applySuppression([signal("a", "low"), signal("b", "medium")], new Set());
    expect(kept).toHaveLength(2);
  });
});
