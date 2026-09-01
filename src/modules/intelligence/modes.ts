/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Mode Matrix
 *
 * The intelligence module is an autonomous control loop. It is enabled one
 * capability at a time, and each stage must be proven before the next is
 * unlocked:
 *
 *   off        nothing scheduled, nothing written
 *   observe    signals + opportunities only — no decisions, no LLM, no actions
 *   recommend  + action_log proposals — still no downstream jobs
 *   route_safe + enqueues read-only analysis jobs — no outreach, no mutation
 *   route_llm  + structured LLM planner — still no live site mutation
 *   full       + outreach and site-mutation candidates
 *
 * TWO INDEPENDENT AXES, DELIBERATELY.
 * A capability runs only when the MODE permits it AND its feature flag is on.
 * The mode alone can never send an email or touch a live site: setting
 * `INTELLIGENCE_MODE=full` by mistake still leaves outreach and site mutation
 * off unless someone also set the corresponding ALLOW_* flag. Two independent
 * mistakes are required to reach an irreversible action, which is the property
 * a single enum cannot give you.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { getConfig } from "../../core/config.js";

export type IntelligenceMode =
  | "off"
  | "observe"
  | "recommend"
  | "route_safe"
  | "route_llm"
  | "full";

export const INTELLIGENCE_MODES: readonly IntelligenceMode[] = [
  "off",
  "observe",
  "recommend",
  "route_safe",
  "route_llm",
  "full",
] as const;

export interface ModeCapabilities {
  /** May write intelligence_runs / intelligence_signals. */
  writesSignals: boolean;
  /** May write intelligence_opportunities. */
  writesOpportunities: boolean;
  /** May write action_log proposals (decisions). */
  writesProposals: boolean;
  /** May enqueue read-only downstream analysis jobs. */
  routesSafeJobs: boolean;
  /** May call the structured LLM planner. */
  usesLlmPlanner: boolean;
  /** May route an outreach job. */
  routesOutreach: boolean;
  /** May route a live-site mutation. */
  routesSiteMutation: boolean;
}

/**
 * What the MODE alone permits, before feature flags are applied.
 * Each row is a strict superset of the row above it.
 */
const MODE_MATRIX: Record<IntelligenceMode, ModeCapabilities> = {
  off: {
    writesSignals: false,
    writesOpportunities: false,
    writesProposals: false,
    routesSafeJobs: false,
    usesLlmPlanner: false,
    routesOutreach: false,
    routesSiteMutation: false,
  },
  observe: {
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: false,
    routesSafeJobs: false,
    usesLlmPlanner: false,
    routesOutreach: false,
    routesSiteMutation: false,
  },
  recommend: {
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: true,
    routesSafeJobs: false,
    usesLlmPlanner: false,
    routesOutreach: false,
    routesSiteMutation: false,
  },
  route_safe: {
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: true,
    routesSafeJobs: true,
    usesLlmPlanner: false,
    routesOutreach: false,
    routesSiteMutation: false,
  },
  route_llm: {
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: true,
    routesSafeJobs: true,
    usesLlmPlanner: true,
    routesOutreach: false,
    routesSiteMutation: false,
  },
  full: {
    writesSignals: true,
    writesOpportunities: true,
    writesProposals: true,
    routesSafeJobs: true,
    usesLlmPlanner: true,
    routesOutreach: true,
    routesSiteMutation: true,
  },
};

/** Mode capabilities with no flag narrowing applied. Exported for tests/docs. */
export function capabilitiesForMode(mode: IntelligenceMode): ModeCapabilities {
  return { ...MODE_MATRIX[mode] };
}

export interface IntelligenceFlags {
  llmPlanningEnabled: boolean;
  allowSafeJobRouting: boolean;
  allowOutreachRouting: boolean;
  allowSiteMutation: boolean;
}

/**
 * Effective capabilities: the mode matrix narrowed by the feature flags.
 * A flag can only ever turn a capability OFF — never on. That direction is the
 * whole safety property, so it is expressed as a boolean AND rather than a
 * lookup that a future edit could invert.
 */
export function resolveCapabilities(
  mode: IntelligenceMode,
  flags: IntelligenceFlags,
): ModeCapabilities {
  const base = MODE_MATRIX[mode];
  return {
    writesSignals: base.writesSignals,
    writesOpportunities: base.writesOpportunities,
    writesProposals: base.writesProposals,
    routesSafeJobs: base.routesSafeJobs && flags.allowSafeJobRouting,
    usesLlmPlanner: base.usesLlmPlanner && flags.llmPlanningEnabled,
    routesOutreach: base.routesOutreach && flags.allowOutreachRouting,
    routesSiteMutation: base.routesSiteMutation && flags.allowSiteMutation,
  };
}

/** Reads mode + flags from validated config. */
export function currentIntelligenceMode(): IntelligenceMode {
  return getConfig().INTELLIGENCE_MODE;
}

export function currentIntelligenceFlags(): IntelligenceFlags {
  const config = getConfig();
  return {
    llmPlanningEnabled: config.INTELLIGENCE_LLM_PLANNING_ENABLED === true,
    allowSafeJobRouting: config.INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING === true,
    allowOutreachRouting: config.INTELLIGENCE_ALLOW_OUTREACH_ROUTING === true,
    allowSiteMutation: config.INTELLIGENCE_ALLOW_SITE_MUTATION === true,
  };
}

export function currentCapabilities(): ModeCapabilities {
  return resolveCapabilities(currentIntelligenceMode(), currentIntelligenceFlags());
}

/** True when the module is entirely off — used to skip scheduling work. */
export function isIntelligenceDisabled(
  mode: IntelligenceMode = currentIntelligenceMode(),
): boolean {
  return mode === "off";
}
