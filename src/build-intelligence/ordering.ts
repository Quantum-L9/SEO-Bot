/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * Deterministic ordering for producer artifacts.
 *
 * Two orderings exist in this package on purpose, and the difference is not
 * stylistic:
 *
 *   - `byCodeUnit` (here) for anything that lands in a sealed artifact or is
 *     compared across machines. UTF-16 code-unit order is a property of the
 *     data alone, so two runs of the same producer on different hosts agree.
 *   - `String#localeCompare` for presentational lists — the signal_types on an
 *     opportunity's evidence, for instance — where order is read by a person
 *     and feeds no digest. `localeCompare` varies with host locale and ICU
 *     version, which is exactly why it must not reach a sealed artifact.
 *
 * When in doubt, use this one: a presentational list ordered by code unit is
 * merely less pretty, whereas a sealed artifact ordered by locale is
 * irreproducible.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
