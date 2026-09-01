/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Attribution feeds the loop's own learning, so the failure that matters is a
 * systematic bias rather than a single wrong row.
 *
 * Two are pinned here:
 *  - SIGN CONVENTION. Lower SERP positions are better, so an improvement is a
 *    NEGATIVE delta. This is the single most-inverted comparison in ranking
 *    code, and inverting it would teach the scorer to prefer whatever makes
 *    rankings worse.
 *  - NULL IS NOT FAILURE. A missing after-measurement returns null, not false.
 *    Recording "no data" as "did not work" would bias the loop against
 *    low-traffic pages, which are exactly the ones most likely to need help.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => ({}),
  schema: {},
}));

vi.mock("../../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  ATTRIBUTION_WINDOW_DAYS,
  attributeRankingChange,
} from "../../../src/modules/intelligence/outcome-attributor.js";

describe("sign convention", () => {
  it("treats a move toward position 1 as success", () => {
    const result = attributeRankingChange({
      keyword: "metal roofing",
      positionBefore: 11,
      positionAfter: 3,
    });
    expect(result.delta).toBe(-8);
    expect(result.success).toBe(true);
    expect(result.learnings).toMatch(/improved/);
  });

  it("treats a move away from position 1 as failure", () => {
    const result = attributeRankingChange({
      keyword: "metal roofing",
      positionBefore: 3,
      positionAfter: 11,
    });
    expect(result.delta).toBe(8);
    expect(result.success).toBe(false);
    expect(result.learnings).toMatch(/worsened/);
  });
});

describe("unmeasurable outcomes are null, never false", () => {
  it.each([
    ["before is null", null, 5],
    ["after is null", 5, null],
    ["both are null", null, null],
  ])("returns null when %s", (_label, before, after) => {
    const result = attributeRankingChange({
      keyword: "k",
      positionBefore: before,
      positionAfter: after,
    });
    expect(result.success).toBeNull();
    expect(result.delta).toBeNull();
    expect(result.learnings).toMatch(/Not measurable/);
  });

  it("returns null for no movement rather than counting it as failure", () => {
    const result = attributeRankingChange({
      keyword: "k",
      positionBefore: 7,
      positionAfter: 7,
    });
    expect(result.delta).toBe(0);
    expect(result.success).toBeNull();
    expect(result.learnings).toMatch(/No movement/);
  });
});

describe("claims stay correlational", () => {
  it("never asserts causation in the recorded learning", () => {
    const result = attributeRankingChange({
      keyword: "k",
      positionBefore: 20,
      positionAfter: 4,
    });
    expect(result.learnings).toMatch(/not a causal claim/i);
    expect(result.learnings).not.toMatch(/\bcaused\b/i);
  });

  it("states the measurement window so a reader can judge the evidence", () => {
    const result = attributeRankingChange({
      keyword: "k",
      positionBefore: 20,
      positionAfter: 4,
    });
    expect(result.learnings).toContain(String(ATTRIBUTION_WINDOW_DAYS));
  });
});
