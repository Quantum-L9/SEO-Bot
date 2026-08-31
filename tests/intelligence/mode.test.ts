/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The rollout ladder is a safety control, and its failure mode is silent: a gate
 * that reads `mode !== "off"` looks correct and grants `observe` the right to
 * queue jobs. So the assertions here are written against the LADDER — every mode
 * against every capability — rather than against the handful of combinations a
 * reviewer happens to think of.
 *
 * The two out-of-ladder flags carry the same weight in the other direction: no
 * mode, including `full`, may grant outreach or site mutation on its own.
 */

import { describe, expect, it } from "vitest";
import {
  followUpJobBlockedReason,
  INTELLIGENCE_MODES,
  type IntelligenceMode,
  OUTREACH_FOLLOW_UP_JOBS,
  resolveCapabilities,
  SITE_MUTATING_FOLLOW_UP_JOBS,
} from "../../src/intelligence/mode.js";

/** Capabilities with both out-of-ladder flags off — the production default. */
function caps(mode: IntelligenceMode, overrides: Partial<Record<string, boolean>> = {}) {
  return resolveCapabilities({
    mode,
    llmPlanningEnabled: (overrides.llmPlanningEnabled as boolean) ?? true,
    allowOutreachRouting: (overrides.allowOutreachRouting as boolean) ?? false,
    allowSiteMutation: (overrides.allowSiteMutation as boolean) ?? false,
  });
}

describe("the rollout ladder", () => {
  it("grants nothing at all in the off mode", () => {
    const c = caps("off");
    expect(c.reason).toBe(false);
    expect(c.propose).toBe(false);
    expect(c.route).toBe(false);
    expect(c.llmPlanning).toBe(false);
    expect(c.outreach).toBe(false);
    expect(c.siteMutation).toBe(false);
  });

  it("lets observe reason WITHOUT proposing — the distinction the whole mode exists for", () => {
    const c = caps("observe");
    expect(c.reason).toBe(true);
    expect(c.propose).toBe(false);
    expect(c.route).toBe(false);
  });

  it("lets recommend propose WITHOUT routing", () => {
    const c = caps("recommend");
    expect(c.propose).toBe(true);
    expect(c.route).toBe(false);
  });

  it("lets route_safe route without reaching a model", () => {
    const c = caps("route_safe");
    expect(c.route).toBe(true);
    expect(c.llmPlanning).toBe(false);
  });

  it("reaches a model only from route_llm upward", () => {
    expect(caps("route_safe").llmPlanning).toBe(false);
    expect(caps("route_llm").llmPlanning).toBe(true);
    expect(caps("full").llmPlanning).toBe(true);
  });

  it("is monotonic: no capability is granted at a rung and withdrawn higher up", () => {
    // A ladder that is not monotonic is not a ladder, and an operator raising
    // the mode to get one capability would silently lose another.
    const keys = ["reason", "propose", "route", "llmPlanning"] as const;
    const rows = INTELLIGENCE_MODES.map((mode) => caps(mode));
    for (const key of keys) {
      for (let i = 1; i < rows.length; i++) {
        const lower = rows[i - 1][key];
        const higher = rows[i][key];
        expect(
          !lower || higher,
          `${key} was granted at ${INTELLIGENCE_MODES[i - 1]} but withdrawn at ${INTELLIGENCE_MODES[i]}`,
        ).toBe(true);
      }
    }
  });
});

describe("the out-of-ladder flags", () => {
  it("denies outreach at EVERY mode when the flag is off, full included", () => {
    for (const mode of INTELLIGENCE_MODES) {
      expect(caps(mode).outreach, `${mode} granted outreach without the flag`).toBe(false);
    }
  });

  it("denies site mutation at EVERY mode when the flag is off, full included", () => {
    for (const mode of INTELLIGENCE_MODES) {
      expect(caps(mode).siteMutation, `${mode} granted site mutation without the flag`).toBe(false);
    }
  });

  it("still denies outreach with the flag on but the ladder below route_safe", () => {
    // Flag AND ladder. Either alone is not enough — an operator who sets the
    // flag early must not acquire the capability the moment reasoning turns on.
    expect(caps("observe", { allowOutreachRouting: true }).outreach).toBe(false);
    expect(caps("recommend", { allowOutreachRouting: true }).outreach).toBe(false);
    expect(caps("route_safe", { allowOutreachRouting: true }).outreach).toBe(true);
  });

  it("still denies site mutation with the flag on but the ladder below route_safe", () => {
    expect(caps("recommend", { allowSiteMutation: true }).siteMutation).toBe(false);
    expect(caps("route_safe", { allowSiteMutation: true }).siteMutation).toBe(true);
  });

  it("keeps the pre-existing LLM kill switch decisive at every mode", () => {
    // INTELLIGENCE_LLM_PLANNING_ENABLED predates the ladder and is documented as
    // stopping all token spend. Raising the mode must never re-enable it.
    for (const mode of INTELLIGENCE_MODES) {
      expect(caps(mode, { llmPlanningEnabled: false }).llmPlanning).toBe(false);
    }
  });
});

describe("followUpJobBlockedReason", () => {
  it("blocks every job below the routing rung", () => {
    expect(followUpJobBlockedReason("serp:competitor-analysis", caps("recommend"))).toMatch(
      /does not queue jobs/,
    );
  });

  it("permits a non-outreach, non-mutating job at route_safe", () => {
    expect(followUpJobBlockedReason("serp:competitor-analysis", caps("route_safe"))).toBeNull();
  });

  it("blocks the outreach job at route_safe — the rung's explicit promise", () => {
    for (const job of OUTREACH_FOLLOW_UP_JOBS) {
      expect(followUpJobBlockedReason(job, caps("route_safe"))).toMatch(/outreach/i);
    }
  });

  it("blocks the outreach job even at full, until the flag is set", () => {
    for (const job of OUTREACH_FOLLOW_UP_JOBS) {
      expect(followUpJobBlockedReason(job, caps("full"))).toMatch(/outreach/i);
      expect(
        followUpJobBlockedReason(job, caps("full", { allowOutreachRouting: true })),
      ).toBeNull();
    }
  });

  it("blocks the live-write job at full, until the site-mutation flag is set", () => {
    for (const job of SITE_MUTATING_FOLLOW_UP_JOBS) {
      expect(followUpJobBlockedReason(job, caps("full"))).toMatch(/site mutation/i);
      expect(followUpJobBlockedReason(job, caps("full", { allowSiteMutation: true }))).toBeNull();
    }
  });

  it("does not let the outreach flag unlock site mutation, or the reverse", () => {
    // The two flags are separate capabilities and must not be interchangeable.
    for (const job of SITE_MUTATING_FOLLOW_UP_JOBS) {
      expect(followUpJobBlockedReason(job, caps("full", { allowOutreachRouting: true }))).toMatch(
        /site mutation/i,
      );
    }
    for (const job of OUTREACH_FOLLOW_UP_JOBS) {
      expect(followUpJobBlockedReason(job, caps("full", { allowSiteMutation: true }))).toMatch(
        /outreach/i,
      );
    }
  });
});
