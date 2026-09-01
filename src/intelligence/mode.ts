/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Plane Rollout Mode (hardening contract C5)
 *
 * One switch that decides how far around the loop the plane is allowed to get.
 * The plane was built to run end-to-end; this decides how much of that end-to-end
 * is live, so a production cutover is a staged rollout rather than an on/off
 * deployment.
 *
 * The modes are a LADDER, not a set of flags: each one is a superset of the one
 * before it. That is deliberate — capability predicates below are written as
 * "rank >= X" rather than as set membership, so adding a mode cannot silently
 * grant a capability to a mode further down the ladder, and no combination of
 * settings can produce a plane that acts without having first reasoned.
 *
 *   off        nothing runs. The plane is installed and inert.
 *   observe    signals and opportunities are recorded. Nothing is proposed.
 *   recommend  proposals and decisions are written. Nothing is executed or queued.
 *   route_safe auto-executed proposals open measurement windows and queue their
 *              non-mutating follow-up jobs.
 *   route_llm  + the model may RANK the remedies a pack already permits.
 *   full       the ladder's top. Note what it still does NOT grant, below.
 *
 * `full` is not "everything". Two capabilities sit OUTSIDE the ladder entirely,
 * behind their own explicit allow-flags, because both are irreversible in a way
 * no amount of measurement makes safe to infer from a mode name:
 *
 *   - outreach routing sends mail to third parties (`INTELLIGENCE_ALLOW_OUTREACH_ROUTING`)
 *   - site mutation writes to a client's live site (`INTELLIGENCE_ALLOW_SITE_MUTATION`)
 *
 * An operator raising the mode to `full` to get better ranking must not thereby
 * acquire the right to email a stranger. Both flags require the ladder AND the
 * flag, so neither can be reached by moving one dial.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** The rollout ladder, lowest capability first. Order is significant. */
export const INTELLIGENCE_MODES = [
  "off",
  "observe",
  "recommend",
  "route_safe",
  "route_llm",
  "full",
] as const;

export type IntelligenceMode = (typeof INTELLIGENCE_MODES)[number];

/** Position on the ladder. Higher is more capable. */
function rank(mode: IntelligenceMode): number {
  return INTELLIGENCE_MODES.indexOf(mode);
}

/**
 * The capability surface, resolved once from config rather than re-derived at
 * each call site. Passing this object around instead of the raw mode string is
 * what keeps a gate from being written as a string comparison someone can get
 * subtly wrong — `mode !== "off"` is true for `observe`, and that is exactly the
 * mistake that would let an observe-mode plane queue jobs.
 */
export interface IntelligenceCapabilities {
  readonly mode: IntelligenceMode;
  /** Run the loop at all: extract signals, group and score opportunities. */
  readonly reason: boolean;
  /** Write action proposals and decision rows. */
  readonly propose: boolean;
  /** Open measurement windows and queue follow-up jobs for auto-executed work. */
  readonly route: boolean;
  /** Reach a model to rank the remedies an evidence pack already permits. */
  readonly llmPlanning: boolean;
  /** Queue the outreach follow-up job, which sends mail to third parties. */
  readonly outreach: boolean;
  /** Queue work that writes to a client's live site. */
  readonly siteMutation: boolean;
}

/**
 * Resolve the capability surface from the mode and the two out-of-ladder flags.
 *
 * `llmPlanning` requires BOTH the ladder position and the existing
 * `INTELLIGENCE_LLM_PLANNING_ENABLED` switch, so the kill switch that predates
 * this contract keeps working exactly as documented: turning it off stops all
 * token spend regardless of mode, and it can never be re-enabled as a side
 * effect of raising the mode.
 */
export function resolveCapabilities(input: {
  mode: IntelligenceMode;
  llmPlanningEnabled: boolean;
  allowOutreachRouting: boolean;
  allowSiteMutation: boolean;
}): IntelligenceCapabilities {
  const position = rank(input.mode);
  const route = position >= rank("route_safe");

  return {
    mode: input.mode,
    reason: position >= rank("observe"),
    propose: position >= rank("recommend"),
    route,
    // Ladder AND flag. Either alone is not enough.
    llmPlanning: position >= rank("route_llm") && input.llmPlanningEnabled,
    // Outreach and site mutation are irreversible, so they need the routing
    // ladder AND their own explicit flag. `full` alone grants neither.
    outreach: route && input.allowOutreachRouting,
    siteMutation: route && input.allowSiteMutation,
  };
}

/**
 * Follow-up jobs that send mail to third parties.
 *
 * Listed by name rather than inferred from the action string, because the action
 * is what the bot decided and the job is what actually reaches the outside
 * world — and it is the second one that needs the flag. Adding an outreach job
 * without adding it here would route mail under `route_safe`, which is the one
 * thing that rung explicitly promises it will not do.
 */
export const OUTREACH_FOLLOW_UP_JOBS: ReadonlySet<string> = new Set(["links:process-outreach"]);

/**
 * Follow-up jobs that write to a client's live site.
 *
 * `serp:execute-surpass-plans` is already excluded from the scheduler's
 * `TRIGGERABLE_JOBS` allow-list (AGENTS §9), so the plane cannot reach it today
 * and this set is a second lock on a door that is already bolted. It is here so
 * that the day someone adds a live-write job to that allow-list, the rollout gate
 * already knows the job is site-mutating instead of silently treating it as safe.
 */
export const SITE_MUTATING_FOLLOW_UP_JOBS: ReadonlySet<string> = new Set([
  "serp:execute-surpass-plans",
]);

/** Why a follow-up job may not be queued, or null when it may. */
export function followUpJobBlockedReason(
  job: string,
  capabilities: IntelligenceCapabilities,
): string | null {
  if (!capabilities.route) {
    return `rollout mode '${capabilities.mode}' records proposals but does not queue jobs`;
  }
  if (OUTREACH_FOLLOW_UP_JOBS.has(job) && !capabilities.outreach) {
    return "outreach routing is disabled (INTELLIGENCE_ALLOW_OUTREACH_ROUTING)";
  }
  if (SITE_MUTATING_FOLLOW_UP_JOBS.has(job) && !capabilities.siteMutation) {
    return "site mutation is disabled (INTELLIGENCE_ALLOW_SITE_MUTATION)";
  }
  return null;
}
