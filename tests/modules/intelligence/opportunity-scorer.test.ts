/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Scoring decides what the loop acts on first, so two properties matter more
 * than any individual number:
 *
 *  - DETERMINISM. Identical inputs must produce byte-identical scores, and no
 *    code path may reach an LLM. If scoring drifted, an operator could never
 *    reproduce why the loop chose an action, and a prompt-injected competitor
 *    title could shift the ranking.
 *  - SUPPRESSION IS EXCLUSION, NOT FILTERING. A suppressed or stale signal must
 *    not contribute its severity to a cluster's peak impact. Dropping such
 *    opportunities from the RESULT would still let a suppressed critical signal
 *    inflate the score of one that survives.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  isStale,
  opportunityFingerprint,
  type ScorableSignal,
  scoreCluster,
  scoreOpportunitiesFromSignals,
  urgencyFor,
} from "../../../src/modules/intelligence/opportunity-scorer.js";

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const NOW = new Date("2026-09-01T00:00:00Z");

function sig(overrides: Partial<ScorableSignal> = {}): ScorableSignal {
  return {
    clientId: CLIENT_A,
    signalType: "keyword_drop",
    entityType: "keyword",
    entityKey: "metal roofing",
    fingerprint: `fp-${Math.random()}`,
    severity: "high",
    confidence: 0.6,
    evidence: {},
    status: "open",
    observedAt: NOW,
    ...overrides,
  };
}

describe("determinism", () => {
  it("produces identical scores for identical inputs", () => {
    const signals = [sig({ fingerprint: "a" }), sig({ fingerprint: "b" })];
    const first = scoreOpportunitiesFromSignals(CLIENT_A, signals, { now: NOW });
    const second = scoreOpportunitiesFromSignals(CLIENT_A, signals, { now: NOW });
    expect(first).toEqual(second);
  });

  it("is independent of signal ordering", () => {
    const a = sig({ fingerprint: "a" });
    const b = sig({ fingerprint: "b" });
    const forward = scoreOpportunitiesFromSignals(CLIENT_A, [a, b], { now: NOW });
    const reverse = scoreOpportunitiesFromSignals(CLIENT_A, [b, a], { now: NOW });
    expect(forward[0].fingerprint).toBe(reverse[0].fingerprint);
    expect(forward[0].score).toBe(reverse[0].score);
  });

  it("fingerprints a cluster independently of member order", () => {
    expect(opportunityFingerprint(CLIENT_A, "content_refresh", ["b", "a"])).toBe(
      opportunityFingerprint(CLIENT_A, "content_refresh", ["a", "b"]),
    );
  });

  it("separates tenants observing the same entity", () => {
    expect(opportunityFingerprint(CLIENT_A, "content_refresh", ["a"])).not.toBe(
      opportunityFingerprint(CLIENT_B, "content_refresh", ["a"]),
    );
  });
});

describe("scoreCluster — ranking behaviour", () => {
  it("ranks high impact + high confidence + low risk above the alternatives", () => {
    const strong = scoreCluster(CLIENT_A, "aeo_answer_block", [
      sig({ signalType: "citation_loss", severity: "critical", confidence: 0.95 }),
    ]);
    const weak = scoreCluster(CLIENT_A, "aeo_answer_block", [
      sig({ signalType: "citation_loss", severity: "low", confidence: 0.1 }),
    ]);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("discounts a high-risk remedy even when the signal is strong", () => {
    // Same severity and strength; only the remedy's risk differs.
    const lowRisk = scoreCluster(CLIENT_A, "aeo_answer_block", [
      sig({ signalType: "citation_loss", severity: "critical", confidence: 0.9 }),
    ]);
    const highRisk = scoreCluster(CLIENT_A, "link_building", [
      sig({ signalType: "prospect_ready", severity: "critical", confidence: 0.9 }),
    ]);
    expect(highRisk.risk).toBeGreaterThan(lowRisk.risk);
    expect(highRisk.score).toBeLessThan(lowRisk.score);
  });

  it("does not let low confidence be rescued by high impact", () => {
    // Multiplicative scoring is the point: a sum would let impact mask this.
    const confident = scoreCluster(CLIENT_A, "content_refresh", [
      sig({ severity: "critical", confidence: 0.9 }),
    ]);
    const unconfident = scoreCluster(CLIENT_A, "content_refresh", [
      sig({ severity: "critical", confidence: 0.05 }),
    ]);
    expect(unconfident.expectedImpact).toBe(confident.expectedImpact);
    expect(unconfident.score).toBeLessThan(confident.score * 0.2);
  });

  it("lets the worst signal set impact rather than averaging it away", () => {
    const oneCritical = scoreCluster(CLIENT_A, "content_refresh", [
      sig({ severity: "critical", confidence: 0.5 }),
    ]);
    const criticalPlusTrivia = scoreCluster(CLIENT_A, "content_refresh", [
      sig({ severity: "critical", confidence: 0.5, fingerprint: "x" }),
      sig({ severity: "low", confidence: 0.5, fingerprint: "y" }),
      sig({ severity: "low", confidence: 0.5, fingerprint: "z" }),
    ]);
    // Averaging severity would DROP impact below the single-critical case.
    expect(criticalPlusTrivia.expectedImpact).toBeGreaterThanOrEqual(oneCritical.expectedImpact);
  });

  it("caps impact at 1 despite the corroboration bonus", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      sig({ severity: "critical", confidence: 1, fingerprint: `f${i}` }),
    );
    expect(scoreCluster(CLIENT_A, "content_refresh", many).expectedImpact).toBeLessThanOrEqual(100);
  });

  it("scores an empty cluster at zero rather than NaN", () => {
    const result = scoreCluster(CLIENT_A, "content_refresh", []);
    expect(result.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });
});

describe("staleness and suppression", () => {
  it("treats a signal older than the window as stale", () => {
    const old = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
    expect(isStale(old, 14, NOW)).toBe(true);
    expect(isStale(NOW, 14, NOW)).toBe(false);
  });

  it("drops stale signals before clustering", () => {
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ observedAt: old, severity: "critical", confidence: 1 })],
      { staleDays: 14, now: NOW },
    );
    expect(result).toHaveLength(0);
  });

  it("excludes a suppressed signal from a surviving cluster's impact", () => {
    const withSuppressed = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [
        sig({ fingerprint: "keep", severity: "low", confidence: 0.3 }),
        sig({ fingerprint: "drop", severity: "critical", confidence: 1, status: "suppressed" }),
      ],
      { now: NOW },
    );
    const withoutSuppressed = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ fingerprint: "keep", severity: "low", confidence: 0.3 })],
      { now: NOW },
    );
    // If suppression were a post-filter, the critical signal would still have
    // raised peak impact here.
    expect(withSuppressed[0].expectedImpact).toBe(withoutSuppressed[0].expectedImpact);
    expect(withSuppressed[0].score).toBe(withoutSuppressed[0].score);
  });
});

describe("urgency", () => {
  it("decays with age even at identical severity", () => {
    // A critical problem seen today and the same problem last seen three weeks
    // ago have identical impact; only one is worth interrupting today's queue.
    const fresh = urgencyFor([sig({ severity: "critical", observedAt: NOW })], 14, NOW);
    const old = urgencyFor(
      [sig({ severity: "critical", observedAt: new Date(NOW.getTime() - 10 * 86400000) })],
      14,
      NOW,
    );
    expect(fresh).toBeGreaterThan(old);
  });

  it("rises with severity at identical age", () => {
    const low = urgencyFor([sig({ severity: "low" })], 14, NOW);
    const critical = urgencyFor([sig({ severity: "critical" })], 14, NOW);
    expect(critical).toBeGreaterThan(low);
  });

  it("stays within 0..1 and is 0 for an empty cluster", () => {
    expect(urgencyFor([], 14, NOW)).toBe(0);
    const u = urgencyFor([sig({ severity: "critical" })], 14, NOW);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
  });
});

describe("scale and thresholds", () => {
  it("produces scores on a 0..100 scale so MIN_SCORE_TO_PLAN is meaningful", () => {
    // A maximal cluster must be able to clear a default threshold of 50;
    // otherwise the config knob would filter everything and read as "broken".
    const best = scoreCluster(
      CLIENT_A,
      "aeo_answer_block",
      [sig({ signalType: "citation_loss", severity: "critical", confidence: 1, observedAt: NOW })],
      { now: NOW },
    );
    expect(best.score).toBeGreaterThan(50);
    expect(best.score).toBeLessThanOrEqual(100);
  });

  it("the one irreversible path cannot clear the default threshold by itself", () => {
    // Deliberate: enabling outreach requires an operator to lower
    // INTELLIGENCE_MIN_SCORE_TO_PLAN on purpose. Not silent — every such block
    // is written to the decision ledger with the score and the threshold.
    const best = scoreCluster(
      CLIENT_A,
      "link_building",
      [sig({ signalType: "prospect_ready", severity: "critical", confidence: 1, observedAt: NOW })],
      { now: NOW },
    );
    expect(best.score).toBeLessThan(50);
  });

  it("the main content path CAN clear the default threshold", () => {
    // The mirror of the test above: if content_refresh could never reach 50,
    // the default config would silently disable the primary use case.
    const best = scoreCluster(
      CLIENT_A,
      "content_refresh",
      [
        sig({ severity: "critical", confidence: 1, observedAt: NOW, fingerprint: "a" }),
        sig({ severity: "critical", confidence: 1, observedAt: NOW, fingerprint: "b" }),
      ],
      { now: NOW },
    );
    expect(best.score).toBeGreaterThan(50);
  });

  it("effort and risk actually affect the ranking", () => {
    // The denominator is max(1, effort + risk). With 0..1 scales that max()
    // would nearly always pick 1 and both factors would silently stop mattering.
    const cheap = scoreCluster(
      CLIENT_A,
      "aeo_answer_block",
      [sig({ signalType: "citation_loss", severity: "critical", confidence: 1 })],
      { now: NOW },
    );
    const expensive = scoreCluster(
      CLIENT_A,
      "link_building",
      [sig({ signalType: "prospect_ready", severity: "critical", confidence: 1 })],
      { now: NOW },
    );
    expect(expensive.effort + expensive.risk).toBeGreaterThan(1);
    expect(expensive.score).toBeLessThan(cheap.score);
  });
});

describe("target extraction", () => {
  it("lifts a target keyword and URL out of signal evidence", () => {
    const result = scoreCluster(
      CLIENT_A,
      "content_refresh",
      [sig({ evidence: { keyword: "metal roofing", url: "https://a.com/roofing" } })],
      { now: NOW },
    );
    expect(result.targetKeyword).toBe("metal roofing");
    expect(result.targetUrl).toBe("https://a.com/roofing");
  });

  it("returns null rather than a placeholder when evidence has neither", () => {
    const result = scoreCluster(CLIENT_A, "budget_risk", [sig({ evidence: {} })], { now: NOW });
    expect(result.targetKeyword).toBeNull();
    expect(result.targetUrl).toBeNull();
  });
});

describe("tenant isolation and clustering", () => {
  it("ignores another client's signals entirely", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ clientId: CLIENT_B, severity: "critical", confidence: 1 })],
      { now: NOW },
    );
    expect(result).toHaveLength(0);
  });

  it("throws rather than running with a missing clientId", () => {
    expect(() => scoreOpportunitiesFromSignals("", [sig()], { now: NOW })).toThrow(/clientId/);
  });

  it("collapses a duplicate signal cluster into exactly one opportunity", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ fingerprint: "a" }), sig({ fingerprint: "b" }), sig({ fingerprint: "c" })],
      { now: NOW },
    );
    expect(result).toHaveLength(1);
    expect(result[0].signalFingerprints).toEqual(["a", "b", "c"]);
  });

  it("maps each signal type to its own opportunity type", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [
        sig({ signalType: "keyword_drop", fingerprint: "k" }),
        sig({ signalType: "bad_lcp_high_exit", fingerprint: "v" }),
        sig({ signalType: "citation_loss", fingerprint: "c" }),
        sig({ signalType: "prospect_ready", fingerprint: "p" }),
      ],
      { now: NOW },
    );
    expect(result.map((r) => r.opportunityType).sort()).toEqual([
      "aeo_answer_block",
      "content_refresh",
      "link_building",
      "technical_seo_fix",
    ]);
  });

  it("returns opportunities highest-score-first", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [
        sig({
          signalType: "citation_loss",
          severity: "critical",
          confidence: 0.95,
          fingerprint: "c",
        }),
        sig({ signalType: "prospect_ready", severity: "low", confidence: 0.1, fingerprint: "p" }),
      ],
      { now: NOW },
    );
    expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
  });

  it("ignores an unrecognised signal type instead of crashing", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ signalType: "some_future_signal" as never, fingerprint: "x" })],
      { now: NOW },
    );
    expect(result).toHaveLength(0);
  });
});
