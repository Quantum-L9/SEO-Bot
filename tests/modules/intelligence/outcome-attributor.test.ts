/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Attribution feeds the loop's own scoring, so the failures that matter are
 * systematic biases rather than single wrong rows. Four are pinned here:
 *
 *  - SIGN CONVENTION. Lower SERP positions are better, so an improvement is a
 *    NEGATIVE delta. Inverting it would teach the scorer to prefer whatever
 *    makes rankings worse.
 *  - NULL IS NOT FAILURE. A missing measurement returns null, not false, or the
 *    loop learns to avoid low-traffic pages — the ones most likely to need help.
 *  - EARLY IS NOT A VERDICT. Seven days is not enough for a ranking to settle;
 *    letting the early window set `success` feeds noise into scoring.
 *  - THE WINDOW IS FIXED IN ADVANCE. Derived from the execution time, so it
 *    cannot be chosen after the result is known.
 */

import { describe, expect, it, vi } from "vitest";

// createModuleLogger reads validated config at import, which exits the process
// when env is absent. The attributor is pure arithmetic; the logger is inert here.
vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  ATTRIBUTION_WINDOWS,
  attributeRankingChange,
  BASELINE_DAYS,
  readyPhase,
  summarizeAttribution,
  windowFor,
} from "../../../src/modules/intelligence/outcome-attributor.js";

const EXECUTED = new Date("2026-08-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("sign convention", () => {
  it("treats a move toward position 1 as success", () => {
    const r = attributeRankingChange({
      keyword: "metal roofing",
      positionBefore: 11,
      positionAfter: 3,
      phase: "primary",
    });
    expect(r.delta).toBe(-8);
    expect(r.success).toBe(true);
    expect(r.learnings).toMatch(/improved/);
  });

  it("treats a move away from position 1 as failure", () => {
    const r = attributeRankingChange({
      keyword: "metal roofing",
      positionBefore: 3,
      positionAfter: 11,
      phase: "primary",
    });
    expect(r.delta).toBe(8);
    expect(r.success).toBe(false);
    expect(r.learnings).toMatch(/worsened/);
  });
});

describe("unmeasurable outcomes are null, never false", () => {
  it.each([
    ["before is null", null, 5],
    ["after is null", 5, null],
    ["both are null", null, null],
  ])("returns null when %s", (_label, before, after) => {
    const r = attributeRankingChange({
      keyword: "k",
      positionBefore: before,
      positionAfter: after,
      phase: "primary",
    });
    expect(r.success).toBeNull();
    expect(r.delta).toBeNull();
    expect(r.learnings).toMatch(/Not measurable/);
  });

  it("returns null for no movement rather than counting it as failure", () => {
    const r = attributeRankingChange({
      keyword: "k",
      positionBefore: 7,
      positionAfter: 7,
      phase: "final",
    });
    expect(r.delta).toBe(0);
    expect(r.success).toBeNull();
    expect(r.learnings).toMatch(/No movement/);
  });
});

describe("the early window observes but never concludes", () => {
  it("records movement without a verdict", () => {
    const r = attributeRankingChange({
      keyword: "k",
      positionBefore: 20,
      positionAfter: 4,
      phase: "early",
    });
    // A big apparent win, and still no verdict: 7 days is not settled.
    expect(r.delta).toBe(-16);
    expect(r.success).toBeNull();
    expect(r.learnings).toMatch(/Too soon for a verdict/);
  });

  it("primary and final DO conclude on the same data", () => {
    for (const phase of ["primary", "final"] as const) {
      const r = attributeRankingChange({
        keyword: "k",
        positionBefore: 20,
        positionAfter: 4,
        phase,
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("windows are fixed in advance", () => {
  it("derives baseline and measurement spans from the execution time", () => {
    const w = windowFor(EXECUTED, "primary");
    expect(w.baselineStart.getTime()).toBe(EXECUTED.getTime() - BASELINE_DAYS * DAY);
    expect(w.baselineEnd.getTime()).toBe(EXECUTED.getTime());
    expect(w.measurementStart.getTime()).toBe(EXECUTED.getTime() + 7 * DAY);
    expect(w.measurementEnd.getTime()).toBe(EXECUTED.getTime() + 21 * DAY);
  });

  it("never overlaps baseline with measurement", () => {
    for (const phase of ["early", "primary", "final"] as const) {
      const w = windowFor(EXECUTED, phase);
      expect(w.baselineEnd.getTime()).toBeLessThanOrEqual(w.measurementStart.getTime());
    }
  });

  it("windows are ordered and non-decreasing across phases", () => {
    expect(ATTRIBUTION_WINDOWS.early.end).toBeLessThanOrEqual(ATTRIBUTION_WINDOWS.primary.start);
    expect(ATTRIBUTION_WINDOWS.primary.end).toBeLessThanOrEqual(ATTRIBUTION_WINDOWS.final.start);
  });
});

describe("readyPhase gates measurement on elapsed time", () => {
  it.each([
    [3, null],
    [8, "early"],
    [22, "primary"],
    [50, "final"],
  ])("at %i days -> %s", (days, expected) => {
    const now = new Date(EXECUTED.getTime() + days * DAY);
    expect(readyPhase(EXECUTED, now)).toBe(expected);
  });

  it("refuses to measure an action taken moments ago", () => {
    expect(readyPhase(EXECUTED, EXECUTED)).toBeNull();
  });
});

describe("claims stay correlational", () => {
  it("never asserts causation", () => {
    const r = attributeRankingChange({
      keyword: "k",
      positionBefore: 20,
      positionAfter: 4,
      phase: "final",
    });
    expect(r.learnings).toMatch(/not a causal claim/i);
    expect(r.learnings).not.toMatch(/\bcaused\b/i);
  });
});

describe("summarizeAttribution", () => {
  it("counts improved, worsened and inconclusive separately", () => {
    const summary = summarizeAttribution([
      attributeRankingChange({
        keyword: "a",
        positionBefore: 10,
        positionAfter: 2,
        phase: "final",
      }),
      attributeRankingChange({
        keyword: "b",
        positionBefore: 2,
        positionAfter: 10,
        phase: "final",
      }),
      attributeRankingChange({
        keyword: "c",
        positionBefore: null,
        positionAfter: 4,
        phase: "final",
      }),
    ]);
    expect(summary).toEqual({ measured: 3, improved: 1, worsened: 1, inconclusive: 1 });
  });
});
