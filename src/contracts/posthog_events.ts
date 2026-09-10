/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Canonical PostHog Event Names
 *
 * The event vocabulary shared across the Website Factory → SEO Bot loop lives in
 * `@quantum-l9/bot-interop` (packages/bot-interop/src/posthog-events.ts), which
 * both repos vendor byte-identically under WBV2-014. This module is SEO-Bot's
 * stable import path for it: Behavior Intelligence queries and any other reader
 * import from here rather than hard-coding strings, so joins line up with what
 * Website-Bot's PostHogSnippetStage actually emits. `posthog_event_alignment` in
 * contracts/website_factory_integration.yaml mirrors these values and is held in
 * parity by tests/contracts/posthog-events-parity.test.ts.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export {
  POSTHOG_EVENTS,
  POSTHOG_LEGACY_EVENT_ALIASES,
  POSTHOG_SITE_EMITTED_EVENTS,
  type PostHogEventName,
} from "@quantum-l9/bot-interop";
