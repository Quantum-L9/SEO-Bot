/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * The mode matrix is the module's outermost safety boundary.
 *
 * Two properties are pinned here that no single test of a downstream component
 * would catch:
 *
 *  - MONOTONICITY. Each mode must be a superset of the one below it. A future
 *    edit that grants `observe` a capability `recommend` lacks would produce a
 *    staging ladder where climbing a rung REMOVES a restriction — the exact
 *    shape of bug a staged rollout exists to prevent.
 *  - FLAGS NARROW ONLY. A feature flag can turn a capability off, never on.
 *    This is checked against the full cross-product rather than a few samples,
 *    because "mode X plus flag Y" is precisely where an accidental OR hides.
 */

import { describe, expect, it } from "vitest";
import {
  capabilitiesForMode,
  INTELLIGENCE_MODES,
  type IntelligenceFlags,
  type ModeCapabilities,
  resolveCapabilities,
} from "../../../src/modules/intelligence/modes.js";

const ALL_ON: IntelligenceFlags = {
  llmPlanningEnabled: true,
  allowSafeJobRouting: true,
  allowOutreachRouting: true,
  allowSiteMutation: true,
};
const ALL_OFF: IntelligenceFlags = {
  llmPlanningEnabled: false,
  allowSafeJobRouting: false,
  allowOutreachRouting: false,
  allowSiteMutation: false,
};

const CAPABILITY_KEYS = [
  "writesSignals",
  "writesOpportunities",
  "writesProposals",
  "routesSafeJobs",
  "usesLlmPlanner",
  "routesOutreach",
  "routesSiteMutation",
] as const satisfies ReadonlyArray<keyof ModeCapabilities>;

describe("mode matrix", () => {
  it("off grants nothing at all", () => {
    const caps = capabilitiesForMode("off");
    for (const key of CAPABILITY_KEYS) expect(caps[key]).toBe(false);
  });

  it("observe writes signals and opportunities but no decisions", () => {
    const caps = capabilitiesForMode("observe");
    expect(caps.writesSignals).toBe(true);
    expect(caps.writesOpportunities).toBe(true);
    expect(caps.writesProposals).toBe(false);
    expect(caps.usesLlmPlanner).toBe(false);
    expect(caps.routesSafeJobs).toBe(false);
  });

  it("recommend writes proposals but queues no downstream jobs", () => {
    const caps = capabilitiesForMode("recommend");
    expect(caps.writesProposals).toBe(true);
    expect(caps.routesSafeJobs).toBe(false);
    expect(caps.routesOutreach).toBe(false);
  });

  it("route_safe queues safe jobs but never outreach or mutation", () => {
    const caps = capabilitiesForMode("route_safe");
    expect(caps.routesSafeJobs).toBe(true);
    expect(caps.usesLlmPlanner).toBe(false);
    expect(caps.routesOutreach).toBe(false);
    expect(caps.routesSiteMutation).toBe(false);
  });

  it("route_llm adds the planner but still no live site mutation", () => {
    const caps = capabilitiesForMode("route_llm");
    expect(caps.usesLlmPlanner).toBe(true);
    expect(caps.routesSiteMutation).toBe(false);
    expect(caps.routesOutreach).toBe(false);
  });

  it("full is the only mode granting outreach and site mutation", () => {
    for (const mode of INTELLIGENCE_MODES) {
      const caps = capabilitiesForMode(mode);
      if (mode === "full") {
        expect(caps.routesOutreach).toBe(true);
        expect(caps.routesSiteMutation).toBe(true);
      } else {
        expect(caps.routesOutreach).toBe(false);
        expect(caps.routesSiteMutation).toBe(false);
      }
    }
  });

  it("each mode is a superset of the mode below it", () => {
    for (let i = 1; i < INTELLIGENCE_MODES.length; i++) {
      const lower = capabilitiesForMode(INTELLIGENCE_MODES[i - 1]);
      const higher = capabilitiesForMode(INTELLIGENCE_MODES[i]);
      for (const key of CAPABILITY_KEYS) {
        if (lower[key]) {
          expect(
            higher[key],
            `${INTELLIGENCE_MODES[i]} must not revoke ${key} granted by ${INTELLIGENCE_MODES[i - 1]}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("flags narrow, never widen", () => {
  it("no flag combination can grant a capability the mode withholds", () => {
    // Full cross-product of modes x the 16 flag combinations.
    for (const mode of INTELLIGENCE_MODES) {
      const base = capabilitiesForMode(mode);
      for (let bits = 0; bits < 16; bits++) {
        const flags: IntelligenceFlags = {
          llmPlanningEnabled: Boolean(bits & 1),
          allowSafeJobRouting: Boolean(bits & 2),
          allowOutreachRouting: Boolean(bits & 4),
          allowSiteMutation: Boolean(bits & 8),
        };
        const resolved = resolveCapabilities(mode, flags);
        for (const key of CAPABILITY_KEYS) {
          if (!base[key]) {
            expect(resolved[key], `${mode}+${bits} wrongly granted ${key}`).toBe(false);
          }
        }
      }
    }
  });

  it("full mode with every flag off routes nothing", () => {
    const caps = resolveCapabilities("full", ALL_OFF);
    expect(caps.routesOutreach).toBe(false);
    expect(caps.routesSiteMutation).toBe(false);
    expect(caps.routesSafeJobs).toBe(false);
    expect(caps.usesLlmPlanner).toBe(false);
    // Observation is not flag-gated — it is always safe.
    expect(caps.writesSignals).toBe(true);
  });

  it("every flag on cannot lift observe above its ceiling", () => {
    const caps = resolveCapabilities("observe", ALL_ON);
    expect(caps.routesSafeJobs).toBe(false);
    expect(caps.usesLlmPlanner).toBe(false);
    expect(caps.routesOutreach).toBe(false);
    expect(caps.routesSiteMutation).toBe(false);
  });

  it("reaching an irreversible action requires two independent switches", () => {
    // full + outreach flag is the ONLY way to routesOutreach.
    expect(resolveCapabilities("full", ALL_ON).routesOutreach).toBe(true);
    expect(
      resolveCapabilities("full", { ...ALL_ON, allowOutreachRouting: false }).routesOutreach,
    ).toBe(false);
    expect(resolveCapabilities("route_llm", ALL_ON).routesOutreach).toBe(false);
  });
});
