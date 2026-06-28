/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Canonical PostHog Event Names
 *
 * Single source of truth for the analytics event names shared across the
 * Website Factory → SEO Bot loop. Mirrors `posthog_event_alignment` in
 * contracts/website_factory_integration.yaml. Both sides must reference these
 * constants rather than hard-coding strings so behaviour-intelligence joins
 * line up with what the generated sites emit.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export const POSTHOG_EVENTS = {
  PAGEVIEW: '$pageview',
  SCROLL_DEPTH: 'scroll_depth',
  LEAD_FORM_SUBMITTED: 'lead_form_submitted',
  CTA_CLICKED: 'cta_clicked',
} as const;

export type PostHogEventName = (typeof POSTHOG_EVENTS)[keyof typeof POSTHOG_EVENTS];
