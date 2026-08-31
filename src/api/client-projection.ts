/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Operator client projection (testing contract §10)
 *
 * `clients.config` is a JSONB blob, and a blob is the one shape a column
 * allow-list cannot protect. The read routes already refuse to select
 * `posthog_api_key` — a named column, easy to see and easy to exclude — and then
 * serialize `config` whole, which carries `site_deployment.githubToken` (a raw
 * GitHub PAT on the pre-v2 path) and `site_deployment.vercelDeployHook` (a URL
 * that deploys a client's site to anyone who holds it).
 *
 * So the projection is a DENY-LIST over the blob rather than an allow-list over
 * the columns: config is operator-facing configuration whose non-secret half is
 * the point of the endpoint (keywords, competitors, velocity), and enumerating
 * that half would drop a new setting silently every time one is added. A
 * deny-list fails the other way — a new key is visible until someone classifies
 * it — which is the right failure for configuration and the wrong one for
 * credentials, hence `assertNoCredentialLeak` below.
 *
 * The keys are matched case-insensitively at ANY depth, because the blob's shape
 * is only as stable as the writers of it: `buildClientConfig` writes
 * `site_deployment` today, and a nested per-environment block tomorrow would
 * move the token one level down without changing its name.
 *
 * The env:// REFERENCE fields (`githubCredentialRef`, `vercelDeployHookRef`) are
 * deliberately NOT redacted. They name where a credential lives; they are not
 * the credential, and an operator reading this endpoint to diagnose a client
 * stuck in `unverified` needs to see which reference failed to resolve.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Keys whose VALUE is a credential, lower-cased for case-insensitive matching.
 *
 * Both spellings of every key are listed. The blob is written by TypeScript
 * (camel) and read by SQL and by hand-maintained fixtures (snake), and a key
 * that survives in one spelling is a leak in that spelling.
 *
 * `tests/api/client-projection.test.ts` asserts this set against the real
 * `ClientSiteDeploymentConfig` declaration, so a new credential field added to
 * the type fails the suite until it is classified here.
 */
export const CLIENT_CONFIG_SECRET_KEYS: ReadonlySet<string> = new Set([
  "githubtoken",
  "github_token",
  "verceldeployhook",
  "vercel_deploy_hook",
]);

/** What a redacted value is replaced WITH — a marker, never a truncated secret. */
export const REDACTED = "[redacted]";

/**
 * Redact credential values anywhere in a config blob.
 *
 * Structure is preserved: a redacted key stays present with a marker value
 * rather than being deleted, so an operator can tell "this client has a token
 * configured" from "this client has none" — which is exactly the distinction
 * that decides whether `siteConfigFromClient` forces a dry-run. Deleting the key
 * would make a configured client and an unconfigured one look identical on the
 * endpoint whose job is to show the difference.
 */
export function redactClientConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactClientConfig);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CLIENT_CONFIG_SECRET_KEYS.has(key.toLowerCase())) {
      // A blank/absent credential is reported as absent rather than as a
      // redacted one: `siteConfigFromClient` treats blank as unconfigured, and
      // the projection should not claim a credential the executor will not use.
      out[key] = typeof nested === "string" && nested.trim() === "" ? nested : REDACTED;
      continue;
    }
    out[key] = redactClientConfig(nested);
  }
  return out;
}

/**
 * Project one client row for an operator response.
 *
 * Takes the row as selected (the column allow-list has already dropped
 * `posthog_api_key`) and replaces `config` with its redacted form.
 */
export function projectClientForApi<T extends { config?: unknown }>(row: T): T {
  if (!row || typeof row !== "object" || !("config" in row)) return row;
  return { ...row, config: redactClientConfig(row.config) };
}

/**
 * Throw if a serialized payload still contains a credential value.
 *
 * The deny-list above is the control; this is the assertion that the control
 * held. It searches for the VALUE rather than the key, so it catches a leak
 * through a path the deny-list never saw — a token copied into a differently
 * named field, or a config shape nobody anticipated.
 *
 * Blank and marker values are ignored: neither is a secret, and treating the
 * empty string as one would make every unconfigured client a failure.
 */
export function assertNoCredentialLeak(payload: unknown, secrets: readonly string[]): void {
  const meaningful = secrets.filter((secret) => secret.trim() !== "" && secret !== REDACTED);
  if (meaningful.length === 0) return;
  const serialized = JSON.stringify(payload) ?? "";
  for (const secret of meaningful) {
    if (serialized.includes(secret)) {
      throw new Error("client projection leaked a credential value");
    }
  }
}
