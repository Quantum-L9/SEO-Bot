/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * Core Web Vitals thresholds (pure leaf — no imports).
 *
 * Held here rather than in `index.ts` for the same reason as
 * `link-building/safety.ts`: the intelligence signal extractor needs the
 * boundary between "acceptable" and "poor" to decide whether a page is slow,
 * and should not import a module that constructs PostHog and notification
 * clients at load time to get it.
 *
 * `index.ts` re-exports this, so existing importers are unaffected.
 */
export const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 }, // ms
  inp: { good: 200, poor: 500 }, // ms
  cls: { good: 0.1, poor: 0.25 }, // score
  fcp: { good: 1800, poor: 3000 }, // ms
  ttfb: { good: 800, poor: 1800 }, // ms
};
