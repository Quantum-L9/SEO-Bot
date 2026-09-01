/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Grouping is the whole claim of the intelligence plane: that a ranking drop and
 * a slow page on the SAME url are one problem, not two. If grouping silently
 * stops co-locating them, nothing fails — the bot just quietly goes back to
 * acting module-by-module, which is the behavior this plane exists to replace.
 *
 * Scoring has to be reproducible for the same reason: an operator asking "why
 * did it do that first?" must get the same answer twice.
 */

import { describe, expect, it } from "vitest";
import {
  buildOpportunities,
  classifyGroup,
  computeScore,
  confidenceFromSignals,
  GROUPING_RULES,
  opportunityShape,
  SCORE_SCALE,
  urgencyFromSignals,
} from "../../src/intelligence/opportunity-scorer.js";
import type { OpportunityType } from "../../src/intelligence/types.js";
import {
  normalizePageKey,
  opportunityFingerprint,
  SIGNAL_TYPES,
  type SignalCandidate,
  type SignalType,
  signalFingerprint,
} from "../../src/intelligence/types.js";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

function signal(signalType: SignalType, overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  const entityId = overrides.entityId ?? `${signalType}-entity`;
  return {
    clientId: CLIENT,
    entityType: "page",
    entityId,
    signalType,
    severity: "medium",
    confidence: 0.8,
    evidence: {},
    fingerprint: signalFingerprint(CLIENT, signalType, entityId),
    groupKey: "/pricing",
    ...overrides,
  };
}

describe("normalizePageKey", () => {
  it("reduces an absolute URL to its path", () => {
    expect(normalizePageKey("https://client.example/pricing")).toBe("/pricing");
  });

  it("drops query strings and fragments so one page is one key", () => {
    expect(normalizePageKey("https://client.example/pricing?utm_source=x#top")).toBe("/pricing");
  });

  it("treats a trailing slash as the same page", () => {
    expect(normalizePageKey("/pricing/")).toBe("/pricing");
  });

  it("maps a bare origin to the root path", () => {
    expect(normalizePageKey("https://client.example")).toBe("/");
    expect(normalizePageKey("https://client.example/")).toBe("/");
  });

  it("returns null for absent input rather than inventing a page", () => {
    expect(normalizePageKey(null)).toBeNull();
    expect(normalizePageKey("")).toBeNull();
    expect(normalizePageKey("   ")).toBeNull();
  });
});

describe("fingerprints", () => {
  it("are stable across calls for the same finding", () => {
    expect(signalFingerprint(CLIENT, "keyword_drop", "roofing austin")).toBe(
      signalFingerprint(CLIENT, "keyword_drop", "roofing austin"),
    );
  });

  it("separate different clients, types, and entities", () => {
    const base = signalFingerprint(CLIENT, "keyword_drop", "a");
    expect(signalFingerprint("00000000-0000-0000-0000-000000000001", "keyword_drop", "a")).not.toBe(
      base,
    );
    expect(signalFingerprint(CLIENT, "lcp_regression", "a")).not.toBe(base);
    expect(signalFingerprint(CLIENT, "keyword_drop", "b")).not.toBe(base);
  });

  it("distinguish opportunity identity by client, type, and target", () => {
    const base = opportunityFingerprint(CLIENT, "keyword_recovery", "/pricing");
    expect(opportunityFingerprint(CLIENT, "keyword_recovery", "/about")).not.toBe(base);
    expect(opportunityFingerprint(CLIENT, "page_experience_repair", "/pricing")).not.toBe(base);
  });
});

describe("classifyGroup", () => {
  it("prefers the compound diagnosis when both symptoms are on one target", () => {
    expect(classifyGroup([signal("keyword_drop"), signal("high_exit_bad_lcp")])).toBe(
      "keyword_drop_plus_page_experience",
    );
  });

  it("falls back to the single-symptom diagnosis when only one is present", () => {
    expect(classifyGroup([signal("keyword_drop")])).toBe("keyword_recovery");
    expect(classifyGroup([signal("high_exit_bad_lcp")])).toBe("page_experience_repair");
  });

  it("classifies a ranking loss alongside a competitor citation as the combined loss", () => {
    expect(classifyGroup([signal("keyword_drop"), signal("competitor_citation_gain")])).toBe(
      "serp_and_answer_engine_loss",
    );
  });

  it("returns null when no rule matches, rather than guessing a type", () => {
    expect(classifyGroup([])).toBeNull();
  });

  it("orders rules most-specific first, so no two-signal rule sits below its subset", () => {
    // A rule requiring {a} placed above a rule requiring {a, b} would make the
    // compound rule unreachable. Checked structurally rather than by eye.
    GROUPING_RULES.forEach((rule, index) => {
      const later = GROUPING_RULES.slice(index + 1);
      for (const candidate of later) {
        const isStrictSuperset =
          candidate.requires.length > rule.requires.length &&
          rule.requires.every((type) => candidate.requires.includes(type));
        expect(
          isStrictSuperset,
          `${candidate.opportunityType} (${candidate.requires.join("+")}) is unreachable ` +
            `below ${rule.opportunityType} (${rule.requires.join("+")})`,
        ).toBe(false);
      }
    });
  });
});

describe("urgency and confidence", () => {
  it("takes urgency from the most severe signal in the group", () => {
    expect(
      urgencyFromSignals([
        signal("keyword_drop", { severity: "low" }),
        signal("high_exit_bad_lcp", { severity: "critical" }),
      ]),
    ).toBe(1);
    expect(urgencyFromSignals([signal("keyword_drop", { severity: "low" })])).toBe(0.25);
  });

  it("averages extractor confidence and clamps to 0..1", () => {
    expect(
      confidenceFromSignals([
        signal("keyword_drop", { confidence: 0.6 }),
        signal("high_exit_bad_lcp", { confidence: 1 }),
      ]),
    ).toBeCloseTo(0.8);
    expect(confidenceFromSignals([])).toBe(0);
  });
});

describe("computeScore", () => {
  it("rewards impact, confidence and urgency; penalizes effort and risk", () => {
    const base = { expectedImpact: 6, confidence: 0.8, urgency: 0.75, effort: 3, risk: 2 };
    expect(computeScore({ ...base, expectedImpact: 9 })).toBeGreaterThan(computeScore(base));
    expect(computeScore({ ...base, confidence: 0.4 })).toBeLessThan(computeScore(base));
    expect(computeScore({ ...base, urgency: 1 })).toBeGreaterThan(computeScore(base));
    expect(computeScore({ ...base, effort: 8 })).toBeLessThan(computeScore(base));
    expect(computeScore({ ...base, risk: 8 })).toBeLessThan(computeScore(base));
  });

  it("never divides by less than one, so a zero-cost item cannot score infinitely", () => {
    const score = computeScore({
      expectedImpact: 10,
      confidence: 1,
      urgency: 1,
      effort: 0,
      risk: 0,
    });
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(10 * SCORE_SCALE);
  });

  it("rounds to the precision the score column stores", () => {
    // numeric(10,4): a score that changes on a database round-trip is not a ranking.
    const score = computeScore({
      expectedImpact: 7,
      confidence: 1 / 3,
      urgency: 0.75,
      effort: 3,
      risk: 2,
    });
    expect(score).toBe(Number(score.toFixed(4)));
  });
});

describe("score calibration against the action threshold", () => {
  // The scale is the one number in this module that fails SILENTLY when wrong:
  // set it too low and every actionable opportunity sits permanently under the
  // default threshold, so the plane observes forever and proposes nothing —
  // with no error, no failing test, and no log line saying so.
  const DEFAULT_MIN_SCORE = 20; // src/core/config.ts INTELLIGENCE_MIN_OPPORTUNITY_SCORE

  const ACTIONABLE: OpportunityType[] = [
    "keyword_drop_plus_page_experience",
    "serp_and_answer_engine_loss",
    "keyword_recovery",
    "page_experience_repair",
    "performance_regression",
    "answer_engine_gap",
    "link_outreach_batch",
  ];

  it("lets every actionable type clear the default threshold at high severity", () => {
    for (const opportunityType of ACTIONABLE) {
      const shape = opportunityShape(opportunityType);
      const score = computeScore({
        expectedImpact: shape.impact,
        effort: shape.effort,
        risk: shape.risk,
        // A high-severity finding an extractor is reasonably sure about — not a
        // theoretical maximum.
        urgency: 0.75,
        confidence: 0.8,
      });
      expect(score, `${opportunityType} scored ${score}`).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
    }
  });

  it("keeps a low-severity single finding below the threshold", () => {
    // The threshold has to separate, not just admit. A low-severity keyword drop
    // the extractor is unsure about should wait for the next cycle.
    const shape = opportunityShape("keyword_recovery");
    const score = computeScore({
      expectedImpact: shape.impact,
      effort: shape.effort,
      risk: shape.risk,
      urgency: 0.25,
      confidence: 0.6,
    });
    expect(score).toBeLessThan(DEFAULT_MIN_SCORE);
  });

  it("ranks the compound diagnosis above either symptom alone", () => {
    const compound = computeScore({
      ...opportunityShape("keyword_drop_plus_page_experience"),
      expectedImpact: opportunityShape("keyword_drop_plus_page_experience").impact,
      urgency: 1,
      confidence: 0.875,
    });
    const single = computeScore({
      ...opportunityShape("keyword_recovery"),
      expectedImpact: opportunityShape("keyword_recovery").impact,
      urgency: 1,
      confidence: 0.875,
    });
    expect(compound).toBeGreaterThan(single);
  });
});

describe("buildOpportunities", () => {
  it("merges signals sharing a target into one opportunity", () => {
    const { opportunities } = buildOpportunities([
      signal("keyword_drop", {
        entityType: "keyword",
        entityId: "roofing austin",
        groupKey: "/roofing",
        evidence: { keyword: "roofing austin", page_path: "/roofing" },
      }),
      signal("high_exit_bad_lcp", {
        entityId: "/roofing",
        groupKey: "/roofing",
        severity: "critical",
        evidence: { page_path: "/roofing", exit_rate: 0.74, lcp: 4100 },
      }),
    ]);

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].opportunityType).toBe("keyword_drop_plus_page_experience");
    expect(opportunities[0].signals).toHaveLength(2);
    expect(opportunities[0].targetUrl).toBe("/roofing");
    expect(opportunities[0].targetKeyword).toBe("roofing austin");
  });

  it("keeps signals about different targets apart", () => {
    const { opportunities } = buildOpportunities([
      signal("keyword_drop", { groupKey: "/a", entityId: "kw-a" }),
      signal("high_exit_bad_lcp", { groupKey: "/b", entityId: "/b" }),
    ]);
    expect(opportunities).toHaveLength(2);
    expect(new Set(opportunities.map((o) => o.opportunityType))).toEqual(
      new Set(["keyword_recovery", "page_experience_repair"]),
    );
  });

  it("keeps different clients apart even when their group keys collide", () => {
    // Two tenants both have a /pricing page. Merging them would be a tenancy leak.
    const other = "00000000-0000-0000-0000-0000000000aa";
    const { opportunities } = buildOpportunities([
      signal("keyword_drop", { groupKey: "/pricing" }),
      signal("keyword_drop", { clientId: other, groupKey: "/pricing", entityId: "other-kw" }),
    ]);
    expect(opportunities).toHaveLength(2);
    expect(new Set(opportunities.map((o) => o.clientId))).toEqual(new Set([CLIENT, other]));
  });

  it("gives every declared signal type a grouping rule", () => {
    // A signal type with no rule produces `ungrouped` signals forever: the
    // extractor runs, rows land in the table, and nothing is ever acted on.
    // Adding an extractor without a rule should fail here, not go quiet.
    const covered = new Set(GROUPING_RULES.flatMap((rule) => rule.requires));
    for (const signalType of SIGNAL_TYPES) {
      expect(covered.has(signalType), `${signalType} has no grouping rule`).toBe(true);
    }
  });

  it("reports unmatched signals as ungrouped rather than dropping them", () => {
    // Simulates a future extractor whose type has no rule yet.
    const orphan = {
      ...signal("keyword_drop", { groupKey: "unmatched" }),
      signalType: "not_yet_grouped" as SignalType,
    };
    const { opportunities, ungrouped } = buildOpportunities([orphan]);
    expect(opportunities).toHaveLength(0);
    expect(ungrouped).toEqual([orphan]);
  });

  it("ranks highest score first with a deterministic tie-break", () => {
    const first = buildOpportunities([
      signal("keyword_drop", { groupKey: "/a", entityId: "a", severity: "low" }),
      signal("high_exit_bad_lcp", { groupKey: "/b", entityId: "/b", severity: "critical" }),
      signal("job_failure_cluster", {
        entityType: "job",
        groupKey: "job:x",
        entityId: "x",
        severity: "high",
      }),
    ]).opportunities;

    const scores = first.map((o) => o.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // Same inputs, different order in → identical ranking out.
    const second = buildOpportunities([
      signal("job_failure_cluster", {
        entityType: "job",
        groupKey: "job:x",
        entityId: "x",
        severity: "high",
      }),
      signal("high_exit_bad_lcp", { groupKey: "/b", entityId: "/b", severity: "critical" }),
      signal("keyword_drop", { groupKey: "/a", entityId: "a", severity: "low" }),
    ]).opportunities;

    expect(second.map((o) => o.fingerprint)).toEqual(first.map((o) => o.fingerprint));
  });

  it("carries the constituent signals into the stored evidence", () => {
    const { opportunities } = buildOpportunities([
      signal("keyword_drop", { groupKey: "/x", evidence: { keyword: "k", position_delta: 9 } }),
    ]);
    expect(opportunities[0].evidence).toMatchObject({
      group_key: "/x",
      signal_types: ["keyword_drop"],
      signal_count: 1,
    });
  });

  it("returns nothing for no signals", () => {
    expect(buildOpportunities([])).toEqual({ opportunities: [], ungrouped: [] });
  });
});
