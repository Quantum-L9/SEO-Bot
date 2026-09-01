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
} from "../../../src/modules/intelligence/opportunity-scorer.js";

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const NOW = new Date("2026-09-01T00:00:00Z");

function sig(overrides: Partial<ScorableSignal> = {}): ScorableSignal {
  return {
    clientId: CLIENT_A,
    signalType: "keyword_drop",
    fingerprint: `fp-${Math.random()}`,
    entityKey: "metal roofing",
    severity: "high",
    strength: 0.6,
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
    expect(opportunityFingerprint(CLIENT_A, "recover_keyword_ranking", ["b", "a"])).toBe(
      opportunityFingerprint(CLIENT_A, "recover_keyword_ranking", ["a", "b"]),
    );
  });

  it("separates tenants observing the same entity", () => {
    expect(opportunityFingerprint(CLIENT_A, "recover_keyword_ranking", ["a"])).not.toBe(
      opportunityFingerprint(CLIENT_B, "recover_keyword_ranking", ["a"]),
    );
  });
});

describe("scoreCluster — ranking behaviour", () => {
  it("ranks high impact + high confidence + low risk above the alternatives", () => {
    const strong = scoreCluster(CLIENT_A, "recover_citation", [
      sig({ signalType: "citation_loss", severity: "critical", strength: 0.95 }),
    ]);
    const weak = scoreCluster(CLIENT_A, "recover_citation", [
      sig({ signalType: "citation_loss", severity: "low", strength: 0.1 }),
    ]);
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("discounts a high-risk remedy even when the signal is strong", () => {
    // Same severity and strength; only the remedy's risk differs.
    const lowRisk = scoreCluster(CLIENT_A, "recover_citation", [
      sig({ signalType: "citation_loss", severity: "critical", strength: 0.9 }),
    ]);
    const highRisk = scoreCluster(CLIENT_A, "acquire_backlink", [
      sig({ signalType: "prospect_ready", severity: "critical", strength: 0.9 }),
    ]);
    expect(highRisk.risk).toBeGreaterThan(lowRisk.risk);
    expect(highRisk.score).toBeLessThan(lowRisk.score);
  });

  it("does not let low confidence be rescued by high impact", () => {
    // Multiplicative scoring is the point: a sum would let impact mask this.
    const confident = scoreCluster(CLIENT_A, "recover_keyword_ranking", [
      sig({ severity: "critical", strength: 0.9 }),
    ]);
    const unconfident = scoreCluster(CLIENT_A, "recover_keyword_ranking", [
      sig({ severity: "critical", strength: 0.05 }),
    ]);
    expect(unconfident.impact).toBe(confident.impact);
    expect(unconfident.score).toBeLessThan(confident.score * 0.2);
  });

  it("lets the worst signal set impact rather than averaging it away", () => {
    const oneCritical = scoreCluster(CLIENT_A, "recover_keyword_ranking", [
      sig({ severity: "critical", strength: 0.5 }),
    ]);
    const criticalPlusTrivia = scoreCluster(CLIENT_A, "recover_keyword_ranking", [
      sig({ severity: "critical", strength: 0.5, fingerprint: "x" }),
      sig({ severity: "low", strength: 0.5, fingerprint: "y" }),
      sig({ severity: "low", strength: 0.5, fingerprint: "z" }),
    ]);
    // Averaging severity would DROP impact below the single-critical case.
    expect(criticalPlusTrivia.impact).toBeGreaterThanOrEqual(oneCritical.impact);
  });

  it("caps impact at 1 despite the corroboration bonus", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      sig({ severity: "critical", strength: 1, fingerprint: `f${i}` }),
    );
    expect(scoreCluster(CLIENT_A, "recover_keyword_ranking", many).impact).toBeLessThanOrEqual(1);
  });

  it("scores an empty cluster at zero rather than NaN", () => {
    const result = scoreCluster(CLIENT_A, "recover_keyword_ranking", []);
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
      [sig({ observedAt: old, severity: "critical", strength: 1 })],
      { staleDays: 14, now: NOW },
    );
    expect(result).toHaveLength(0);
  });

  it("excludes a suppressed signal from a surviving cluster's impact", () => {
    const withSuppressed = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [
        sig({ fingerprint: "keep", severity: "low", strength: 0.3 }),
        sig({ fingerprint: "drop", severity: "critical", strength: 1, status: "suppressed" }),
      ],
      { now: NOW },
    );
    const withoutSuppressed = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ fingerprint: "keep", severity: "low", strength: 0.3 })],
      { now: NOW },
    );
    // If suppression were a post-filter, the critical signal would still have
    // raised peak impact here.
    expect(withSuppressed[0].impact).toBe(withoutSuppressed[0].impact);
    expect(withSuppressed[0].score).toBe(withoutSuppressed[0].score);
  });
});

describe("tenant isolation and clustering", () => {
  it("ignores another client's signals entirely", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [sig({ clientId: CLIENT_B, severity: "critical", strength: 1 })],
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
      "acquire_backlink",
      "fix_slow_exit_page",
      "recover_citation",
      "recover_keyword_ranking",
    ]);
  });

  it("returns opportunities highest-score-first", () => {
    const result = scoreOpportunitiesFromSignals(
      CLIENT_A,
      [
        sig({
          signalType: "citation_loss",
          severity: "critical",
          strength: 0.95,
          fingerprint: "c",
        }),
        sig({ signalType: "prospect_ready", severity: "low", strength: 0.1, fingerprint: "p" }),
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
