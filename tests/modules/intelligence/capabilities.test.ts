/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Capability resolution is the module's outermost switch, and the property that
 * matters is directional: INTELLIGENCE_ENABLED gates everything downstream, and
 * no narrower flag can re-enable a capability the master switch withheld.
 *
 * Checked against the full flag cross-product rather than a few samples,
 * because "enabled off but flag X on" is exactly where an accidental OR hides.
 */

import { describe, expect, it } from "vitest";
import {
  type IntelligenceCapabilities,
  resolveCapabilities,
} from "../../../src/modules/intelligence/capabilities.js";

type FlagConfig = Parameters<typeof resolveCapabilities>[0];

function config(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    INTELLIGENCE_ENABLED: true,
    INTELLIGENCE_LLM_PLANNING_ENABLED: false,
    INTELLIGENCE_AUTO_ROUTE_LOW_RISK: false,
    INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED: false,
    INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT: 10,
    INTELLIGENCE_MIN_SCORE_TO_PLAN: 50,
    INTELLIGENCE_SIGNAL_STALE_DAYS: 14,
    ...overrides,
  } as FlagConfig;
}

const BOOLEAN_CAPS = [
  "usesLlmPlanner",
  "autoRouteLowRisk",
  "portfolioBenchmark",
] as const satisfies ReadonlyArray<keyof IntelligenceCapabilities>;

describe("the master switch gates everything", () => {
  it("grants nothing when INTELLIGENCE_ENABLED is false", () => {
    const caps = resolveCapabilities(config({ INTELLIGENCE_ENABLED: false }));
    expect(caps.enabled).toBe(false);
    for (const key of BOOLEAN_CAPS) expect(caps[key]).toBe(false);
  });

  it("no flag combination re-enables a capability when disabled", () => {
    for (let bits = 0; bits < 8; bits++) {
      const caps = resolveCapabilities(
        config({
          INTELLIGENCE_ENABLED: false,
          INTELLIGENCE_LLM_PLANNING_ENABLED: Boolean(bits & 1),
          INTELLIGENCE_AUTO_ROUTE_LOW_RISK: Boolean(bits & 2),
          INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED: Boolean(bits & 4),
        }),
      );
      for (const key of BOOLEAN_CAPS) {
        expect(caps[key], `flags ${bits} wrongly granted ${key} while disabled`).toBe(false);
      }
    }
  });

  it("enabled alone grants no optional capability", () => {
    // Turning the module on must not turn on planning or routing by implication.
    const caps = resolveCapabilities(config());
    expect(caps.enabled).toBe(true);
    for (const key of BOOLEAN_CAPS) expect(caps[key]).toBe(false);
  });
});

describe("individual flags", () => {
  it("LLM planning requires both the master switch and its own flag", () => {
    expect(
      resolveCapabilities(config({ INTELLIGENCE_LLM_PLANNING_ENABLED: true })).usesLlmPlanner,
    ).toBe(true);
    expect(
      resolveCapabilities(
        config({ INTELLIGENCE_ENABLED: false, INTELLIGENCE_LLM_PLANNING_ENABLED: true }),
      ).usesLlmPlanner,
    ).toBe(false);
  });

  it("auto-routing is independent of planning", () => {
    const caps = resolveCapabilities(config({ INTELLIGENCE_AUTO_ROUTE_LOW_RISK: true }));
    expect(caps.autoRouteLowRisk).toBe(true);
    expect(caps.usesLlmPlanner).toBe(false);
  });

  it("carries the numeric thresholds through unchanged", () => {
    const caps = resolveCapabilities(
      config({
        INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT: 3,
        INTELLIGENCE_MIN_SCORE_TO_PLAN: 72.5,
        INTELLIGENCE_SIGNAL_STALE_DAYS: 30,
      }),
    );
    expect(caps.maxOpportunitiesPerClient).toBe(3);
    expect(caps.minScoreToPlan).toBe(72.5);
    expect(caps.signalStaleDays).toBe(30);
  });
});
