/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Canonical PostHog Event Constants — GAP-10
 *
 * BOTH repos (SEO-Bot + Website-Bot) must maintain an IDENTICAL copy of this
 * file. The CI script `scripts/check-posthog-events-drift.sh` verifies this.
 *
 * Event names defined here MUST match what Website-Bot's PostHogSnippetStage
 * instruments. SEO-Bot's behavior-intelligence module queries for these names.
 *
 * DO NOT rename events without updating BOTH repos simultaneously.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export const POSTHOG_EVENTS = {
  // Lead capture
  LEAD_FORM_SUBMITTED: 'lead_form_submitted',
  LEAD_FORM_STARTED: 'lead_form_started',

  // CTA interactions
  CTA_CLICKED: 'cta_clicked',
  CTA_CLICK: 'cta_click',             // legacy alias — normalize to CTA_CLICKED

  // Navigation
  PAGE_VIEWED: '$pageview',
  PAGE_LEFT: '$pageleave',

  // Engagement
  SCROLL_DEPTH_50: 'scroll_depth_50',
  SCROLL_DEPTH_75: 'scroll_depth_75',
  SCROLL_DEPTH_90: 'scroll_depth_90',

  // Form
  FORM_SUBMIT: 'form_submit',         // legacy alias — normalize to LEAD_FORM_SUBMITTED
  PHONE_CLICK: 'phone_click',
  EMAIL_CLICK: 'email_click',

  // Trust signals
  REVIEW_SECTION_VIEWED: 'review_section_viewed',
  GALLERY_VIEWED: 'gallery_viewed',
} as const;

export type PostHogEventName = typeof POSTHOG_EVENTS[keyof typeof POSTHOG_EVENTS];

/**
 * Canonical query names used by behavior-intelligence module.
 * These are what the PostHog API queries should use.
 */
export const CANONICAL_EVENTS = [
  POSTHOG_EVENTS.LEAD_FORM_SUBMITTED,
  POSTHOG_EVENTS.CTA_CLICKED,
  POSTHOG_EVENTS.PHONE_CLICK,
  POSTHOG_EVENTS.SCROLL_DEPTH_75,
] as const;
