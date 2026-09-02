/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Attribution is the difference between a bot that learns and a bot that just
 * acts. The failure mode is not a crash — it is a confident wrong verdict
 * recorded as a learning, which the next cycle then reasons from.
 *
 * So the tests concentrate on the two directions that are easy to get backwards:
 * SERP position and exit rate improve when they go DOWN, citation rate when it
 * goes UP; and on thin samples, which must return `inconclusive` rather than a
 * verdict.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/database/index.js", () => ({ getDb: () => ({}), schema: {} }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  buildWindows,
  judgeComparison,
  type MetricComparison,
  summarizeExperiment,
} from "../../src/intelligence/outcome-attributor.js";
import {
  CIRCUIT_BREAKER_DECLINE_PCT,
  CIRCUIT_BREAKER_MIN_KEYWORDS,
  computeDailyLlmHeadroom,
  daysRemainingInMonth,
  isCircuitOpen,
} from "../../src/intelligence/policy-state.js";

function comparison(overrides: Partial<MetricComparison> = {}): MetricComparison {
  return {
    baseline: 10,
    measured: 5,
    delta: -5,
    sampleCountBaseline: 10,
    sampleCountMeasured: 10,
    ...overrides,
  };
}

const LOWER_BETTER = { lowerIsBetter: true, minSamples: 3, minRelativeChange: 0.05 };
const HIGHER_BETTER = { lowerIsBetter: false, minSamples: 3, minRelativeChange: 0.1 };

describe("buildWindows", () => {
  it("places the baseline before the change and the measurement after it", () => {
    const executedAt = new Date("2026-08-01T12:00:00Z");
    const windows = buildWindows(executedAt, 14, 28);

    expect(windows.baselineEnd).toEqual(executedAt);
    expect(windows.measurementStart).toEqual(executedAt);
    expect(windows.baselineStart.toISOString()).toBe("2026-07-18T12:00:00.000Z");
    expect(windows.measurementEnd.toISOString()).toBe("2026-08-29T12:00:00.000Z");
  });

  it("never lets the baseline include the change's own effect", () => {
    // Crediting a fix with the damage it repaired is the classic attribution bug.
    const executedAt = new Date("2026-08-01T00:00:00Z");
    const windows = buildWindows(executedAt, 7, 7);
    expect(windows.baselineEnd.getTime()).toBeLessThanOrEqual(windows.measurementStart.getTime());
    expect(windows.baselineStart.getTime()).toBeLessThan(windows.baselineEnd.getTime());
  });
});

describe("judgeComparison — direction", () => {
  it("counts a FALLING SERP position as an improvement", () => {
    // Position 5 beats position 12; the number going down is the win.
    expect(judgeComparison(comparison({ baseline: 12, measured: 5 }), LOWER_BETTER)).toBe(
      "improved",
    );
    expect(judgeComparison(comparison({ baseline: 5, measured: 12 }), LOWER_BETTER)).toBe(
      "declined",
    );
  });

  it("counts a RISING citation rate as an improvement", () => {
    expect(judgeComparison(comparison({ baseline: 20, measured: 45 }), HIGHER_BETTER)).toBe(
      "improved",
    );
    expect(judgeComparison(comparison({ baseline: 45, measured: 20 }), HIGHER_BETTER)).toBe(
      "declined",
    );
  });
});

describe("judgeComparison — refusing to over-read", () => {
  it("calls a sub-threshold move unchanged rather than an improvement", () => {
    expect(judgeComparison(comparison({ baseline: 10, measured: 9.7 }), LOWER_BETTER)).toBe(
      "unchanged",
    );
  });

  it("returns inconclusive on a thin baseline or a thin measurement", () => {
    expect(judgeComparison(comparison({ sampleCountBaseline: 2 }), LOWER_BETTER)).toBe(
      "inconclusive",
    );
    expect(judgeComparison(comparison({ sampleCountMeasured: 1 }), LOWER_BETTER)).toBe(
      "inconclusive",
    );
  });

  it("returns inconclusive when either side has no data at all", () => {
    expect(judgeComparison(comparison({ baseline: null }), LOWER_BETTER)).toBe("inconclusive");
    expect(judgeComparison(comparison({ measured: null }), LOWER_BETTER)).toBe("inconclusive");
  });

  it("does not divide by a zero baseline", () => {
    expect(judgeComparison(comparison({ baseline: 0, measured: 0 }), LOWER_BETTER)).toBe(
      "unchanged",
    );
    expect(judgeComparison(comparison({ baseline: 0, measured: 5 }), LOWER_BETTER)).toBe(
      "inconclusive",
    );
  });

  it("applies the metric's own change threshold", () => {
    // 8% moves a 5%-threshold metric but not a 10%-threshold one.
    const eightPercentUp = comparison({ baseline: 100, measured: 108 });
    expect(judgeComparison(eightPercentUp, HIGHER_BETTER)).toBe("unchanged");
    expect(judgeComparison(eightPercentUp, { ...HIGHER_BETTER, minRelativeChange: 0.05 })).toBe(
      "improved",
    );
  });
});

describe("summarizeExperiment", () => {
  const base = {
    hypothesis: "Tightening the title recovers the position.",
    targetMetric: "serp_position" as const,
    entityId: "roofing austin",
  };

  it("records a refutation as a refutation, not as a neutral note", () => {
    const learning = summarizeExperiment({
      ...base,
      verdict: "declined",
      comparison: comparison({ baseline: 5, measured: 12, delta: 7 }),
    });
    expect(learning).toMatch(/^REFUTED:/);
    expect(learning).toContain("5 → 12");
    expect(learning).toMatch(/do not repeat/i);
  });

  it("marks a confirmed hypothesis with its numbers", () => {
    const learning = summarizeExperiment({
      ...base,
      verdict: "improved",
      comparison: comparison({ baseline: 12, measured: 4, delta: -8 }),
    });
    expect(learning).toMatch(/^CONFIRMED:/);
    expect(learning).toContain("12 → 4");
  });

  it("distinguishes 'no effect' from 'we could not tell'", () => {
    expect(
      summarizeExperiment({ ...base, verdict: "unchanged", comparison: comparison() }),
    ).toMatch(/^NO EFFECT:/);
    expect(
      summarizeExperiment({
        ...base,
        verdict: "inconclusive",
        comparison: comparison({ baseline: null, measured: null, delta: null }),
      }),
    ).toMatch(/^INCONCLUSIVE:.*No learning recorded/s);
  });
});

describe("policy state math", () => {
  it("spends against an explicit daily cap when one is configured", () => {
    expect(
      computeDailyLlmHeadroom({
        dailyCapUsd: 10,
        todaySpendUsd: 4,
        monthlyBudgetUsd: 200,
        monthToDateSpendUsd: 50,
        daysRemaining: 10,
      }),
    ).toBe(6);
  });

  it("pro-rates the month's remainder when no daily cap is set", () => {
    // A real daily allowance, not a monthly figure wearing a daily name.
    expect(
      computeDailyLlmHeadroom({
        dailyCapUsd: undefined,
        todaySpendUsd: 0,
        monthlyBudgetUsd: 200,
        monthToDateSpendUsd: 100,
        daysRemaining: 10,
      }),
    ).toBe(10);
  });

  it("reports overspend as zero headroom, never as a negative allowance", () => {
    expect(
      computeDailyLlmHeadroom({
        dailyCapUsd: 10,
        todaySpendUsd: 25,
        monthlyBudgetUsd: 200,
        monthToDateSpendUsd: 400,
        daysRemaining: 5,
      }),
    ).toBe(0);
  });

  it("never divides by zero days remaining", () => {
    const headroom = computeDailyLlmHeadroom({
      dailyCapUsd: undefined,
      todaySpendUsd: 0,
      monthlyBudgetUsd: 200,
      monthToDateSpendUsd: 0,
      daysRemaining: 0,
    });
    expect(Number.isFinite(headroom)).toBe(true);
    expect(headroom).toBe(200);
  });

  it("counts the days left in the month, including today", () => {
    expect(daysRemainingInMonth(new Date("2026-08-31T12:00:00Z"))).toBe(1);
    expect(daysRemainingInMonth(new Date("2026-08-01T00:00:00Z"))).toBe(31);
    expect(daysRemainingInMonth(new Date("2026-02-28T00:00:00Z"))).toBe(1);
  });

  it("opens the ranking circuit only on a real share of a real sample", () => {
    expect(isCircuitOpen(4, 10)).toBe(true); // 40% >= 30%
    expect(isCircuitOpen(2, 10)).toBe(false); // 20% < 30%
    // Two of three keywords is 66%, but three keywords is not a portfolio.
    expect(isCircuitOpen(2, 3)).toBe(false);
  });

  it("uses the thresholds it documents", () => {
    expect(CIRCUIT_BREAKER_DECLINE_PCT).toBe(30);
    expect(CIRCUIT_BREAKER_MIN_KEYWORDS).toBe(5);
    expect(isCircuitOpen(CIRCUIT_BREAKER_MIN_KEYWORDS, CIRCUIT_BREAKER_MIN_KEYWORDS)).toBe(true);
  });
});
