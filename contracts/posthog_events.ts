/* L9_META
 * layer: contract
 * role: seo_bot_engine
 * status: active
 */

export const POSTHOG_EVENTS = {
  PAGEVIEW: '$pageview',
  SCROLL_DEPTH: 'scroll_depth',
  LEAD_FORM_SUBMITTED: 'lead_form_submitted',
  CTA_CLICKED: 'cta_clicked',
} as const;

export type PostHogEventName = typeof POSTHOG_EVENTS[keyof typeof POSTHOG_EVENTS];
