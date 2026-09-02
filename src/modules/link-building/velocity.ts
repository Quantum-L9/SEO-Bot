/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * The outreach caps this governor enforces. Exported so the intelligence
 * plane's policy state computes headroom from the SAME numbers the outreach job
 * enforces — two copies of a velocity cap is how a governor stops governing.
 */
export const LINK_VELOCITY = {
  maxLinksPerWeek: 5,
  maxEmailsPerDay: 10,
} as const;

/**
 * Link-velocity governor math (pure, unit-testable).
 *
 * The number of NEW outreach emails allowed in a single run is the smaller of
 * the daily cap and the weekly cap's remaining headroom. This keeps a client
 * under maxLinksPerWeek even though the job runs every weekday — the daily cap
 * alone (e.g. 10/day) would otherwise permit ~70/week.
 */
export function velocityRunLimit(
  sentThisWeek: number,
  maxPerWeek: number,
  maxPerDay: number,
): number {
  const weeklyRemaining = Math.max(0, maxPerWeek - Math.max(0, sentThisWeek));
  return Math.min(maxPerDay, weeklyRemaining);
}
