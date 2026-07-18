/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * Link-velocity governor math (pure, unit-testable).
 *
 * The number of NEW outreach emails allowed in a single run is the smaller of
 * the daily cap and the weekly cap's remaining headroom. This keeps a client
 * under maxLinksPerWeek even though the job runs every weekday — the daily cap
 * alone (e.g. 10/day) would otherwise permit ~70/week.
 */
export function velocityRunLimit(sentThisWeek: number, maxPerWeek: number, maxPerDay: number): number {
  const weeklyRemaining = Math.max(0, maxPerWeek - Math.max(0, sentThisWeek));
  return Math.min(maxPerDay, weeklyRemaining);
}
