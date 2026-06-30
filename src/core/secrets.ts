/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Infisical Secret Loader
 *
 * Hydrates process.env from Infisical (https://infisical.com) so the bot can run
 * autonomously on a VPS without a committed/synced .env file. Uses a machine
 * identity (Universal Auth) — no human in the loop.
 *
 * Design goals:
 *  - OPTIONAL: if the bootstrap vars (INFISICAL_CLIENT_ID / _CLIENT_SECRET /
 *    _PROJECT_ID) are absent, this is a no-op and the bot falls back to
 *    .env / process.env exactly as before. Nothing breaks for local dev.
 *  - NON-DESTRUCTIVE: an Infisical secret never overwrites a variable that is
 *    already set in the environment, so an explicit shell/systemd export or a
 *    local .env always wins. Infisical only *backfills* what's missing.
 *  - FAIL-SOFT by default: a fetch/auth failure logs a warning and lets the bot
 *    continue on whatever env it already has. Set INFISICAL_REQUIRED=true to
 *    make Infisical a hard dependency that aborts boot on any failure.
 *
 * The @infisical/sdk dependency is imported lazily, so it is only resolved when
 * Infisical is actually configured.
 *
 * Bootstrap env vars (see .env.example):
 *   INFISICAL_CLIENT_ID       machine-identity client id      (required to enable)
 *   INFISICAL_CLIENT_SECRET   machine-identity client secret  (required to enable)
 *   INFISICAL_PROJECT_ID      project / workspace id          (required to enable)
 *   INFISICAL_ENV             environment slug   (default: 'prod')
 *   INFISICAL_SECRET_PATH     secret folder path (default: '/')
 *   INFISICAL_SITE_URL        self-hosted instance URL (default: app.infisical.com)
 *   INFISICAL_RECURSIVE       'true' to pull nested folders too (default: false)
 *   INFISICAL_REQUIRED        'true' to abort boot if the load fails (default: false)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('secrets');

export interface LoadSecretsResult {
  /** True only when secrets were successfully fetched from Infisical. */
  loaded: boolean;
  /** Number of keys actually injected into process.env (missing keys only). */
  injected: number;
  /** Where the effective config ultimately comes from. */
  source: 'infisical' | 'env';
}

/** Parse a loose boolean env var ('1' / 'true', case-insensitive). */
function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Load secrets from Infisical into process.env. Safe to call exactly once,
 * before configuration is validated (loadConfig / getConfig).
 */
export async function loadSecrets(): Promise<LoadSecretsResult> {
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  const projectId = process.env.INFISICAL_PROJECT_ID;
  const required = envFlag(process.env.INFISICAL_REQUIRED);

  // Not configured → no-op fallback to .env / process.env.
  if (!clientId || !clientSecret || !projectId) {
    if (required) {
      throw new Error(
        'INFISICAL_REQUIRED=true but INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET ' +
          'and INFISICAL_PROJECT_ID are not all set.',
      );
    }
    logger.debug('Infisical not configured — using .env / process.env only');
    return { loaded: false, injected: 0, source: 'env' };
  }

  const environment = process.env.INFISICAL_ENV ?? 'prod';
  const secretPath = process.env.INFISICAL_SECRET_PATH ?? '/';
  const siteUrl = process.env.INFISICAL_SITE_URL;
  const recursive = envFlag(process.env.INFISICAL_RECURSIVE);

  try {
    // Lazy import: the SDK is only loaded when Infisical is configured.
    const { InfisicalSDK } = await import('@infisical/sdk');
    const client = new InfisicalSDK(siteUrl ? { siteUrl } : {});

    await client.auth().universalAuth.login({ clientId, clientSecret });

    const { secrets } = await client.secrets().listSecrets({
      environment,
      projectId,
      secretPath,
      recursive,
      expandSecretReferences: true,
    });

    let injected = 0;
    for (const secret of secrets) {
      // Never clobber an already-set var: explicit env / .env wins.
      if (process.env[secret.secretKey] === undefined) {
        process.env[secret.secretKey] = secret.secretValue;
        injected++;
      }
    }

    logger.info(
      { environment, secretPath, fetched: secrets.length, injected },
      'Loaded secrets from Infisical',
    );
    return { loaded: true, injected, source: 'infisical' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (required) {
      throw new Error(`Infisical secret load failed (INFISICAL_REQUIRED=true): ${message}`);
    }
    logger.warn(
      { error: message },
      'Infisical secret load failed — continuing with .env / process.env',
    );
    return { loaded: false, injected: 0, source: 'env' };
  }
}
