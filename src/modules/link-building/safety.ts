/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * Link-building safety constants (pure leaf — no imports).
 *
 * Held here rather than in `index.ts` so a caller that needs only the numbers
 * does not pull in the whole module. `index.ts` reaches the LLM service, the
 * notification service, and the database at import time; the intelligence
 * policy gate needs none of those to know what the weekly cap is, and pulling
 * them in would make a safety check depend on an outbound-mail client.
 *
 * `index.ts` re-exports this, so existing importers are unaffected.
 */
export const SAFETY = {
  maxLinksPerWeek: 5, // Conservative velocity
  minDomainRating: 20, // Minimum DR for prospects
  maxEmailsPerDay: 10, // Daily outreach cap
  followUpDelayDays: 3, // Days between follow-ups
  maxFollowUps: 2, // Max follow-up emails per prospect
  circuitBreakerDropPct: 30, // Pause if rankings drop 30%+
};
