/* L9_META
 * layer: core
 * role: posthog_credential_resolution
 * status: active
 */

/**
 * PostHog credential planes (SEO-Bot#18).
 *
 * 1. Per-client project key — `clients.posthog_api_key` (usually `phc_*`):
 *    ingestion / tracking snippet + "PostHog configured" gate.
 * 2. Shared query key — `POSTHOG_PERSONAL_API_KEY` (`phx_*`): HogQL / Query API
 *    against the self-hosted instance (org secret + Infisical, not per-repo git).
 *
 * Multi-org tenants: store a personal/query key (`phx_*`) in
 * `clients.posthog_api_key` so Query API auth uses that tenant's PostHog org
 * instead of the shared personal key.
 */

export function isPostHogPersonalApiKey(key: string): boolean {
  return key.trim().startsWith("phx_");
}

export function isPostHogProjectApiKey(key: string): boolean {
  return key.trim().startsWith("phc_");
}

/**
 * Resolve the Bearer token for PostHog Query / Insights APIs.
 * Prefers a per-client personal key when present; otherwise the shared personal key.
 */
export function resolvePostHogQueryApiKey(
  clientPosthogApiKey: string | null | undefined,
  personalApiKey: string,
): string {
  const clientKey = clientPosthogApiKey?.trim();
  if (clientKey && isPostHogPersonalApiKey(clientKey)) {
    return clientKey;
  }
  return personalApiKey;
}
