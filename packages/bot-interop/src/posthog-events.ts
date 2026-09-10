/**
 * Canonical PostHog event vocabulary for the Website-Bot → SEO-Bot analytics
 * seam.
 *
 * Website-Bot's PostHogSnippetStage emits these names from every generated
 * site and SEO-Bot's Behavior Intelligence queries join on them. Both sides
 * import this module — neither may carry an independent literal — and the
 * vendored copies are held byte-identical by WBV2-014
 * (contracts/BOT_INTEROP_PARITY.json), so a rename lands on both peers or on
 * neither.
 *
 * Property shape per event. Every custom event also carries PostHog's
 * automatic `$current_url`, which is the key SEO-Bot groups pages on.
 *
 * - `$pageview`           PostHog automatic pageview (`capture_pageview`).
 * - `scroll_depth`        `{ scroll_depth: integer percent 0..100, page_path }`,
 *                         sent once per page when the document becomes hidden.
 * - `cta_clicked`         `{ label, page_path }`.
 * - `lead_form_submitted` `{ form_id, page_path }`.
 */
export const POSTHOG_EVENTS = {
  PAGEVIEW: "$pageview",
  SCROLL_DEPTH: "scroll_depth",
  LEAD_FORM_SUBMITTED: "lead_form_submitted",
  CTA_CLICKED: "cta_clicked",
} as const;

export type PostHogEventName = (typeof POSTHOG_EVENTS)[keyof typeof POSTHOG_EVENTS];

/**
 * Custom events a generated site must emit itself. `$pageview` is excluded
 * because posthog-js captures it automatically.
 */
export const POSTHOG_SITE_EMITTED_EVENTS: readonly PostHogEventName[] = [
  POSTHOG_EVENTS.SCROLL_DEPTH,
  POSTHOG_EVENTS.CTA_CLICKED,
  POSTHOG_EVENTS.LEAD_FORM_SUBMITTED,
];

/**
 * Pre-alignment names that generated sites emitted before this contract
 * existed. Website-Bot dual-emits each alias next to its canonical event for a
 * transition window, keeping the property shape those names always had
 * (`cta_click`: `{ label, page }`; `form_submit`: `{ formId, page }`), so
 * dashboards built on already-deployed sites keep receiving the data they were
 * built on. SEO-Bot never queries an alias. Removing an entry here is the
 * contract change that ends the window, and like every change to this file it
 * must land on both peers.
 */
export const POSTHOG_LEGACY_EVENT_ALIASES: Readonly<Partial<Record<PostHogEventName, string>>> = {
  cta_clicked: "cta_click",
  lead_form_submitted: "form_submit",
};
