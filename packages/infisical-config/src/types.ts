/**
 * Minimal structured logger, compatible with pino's `logger.info(obj, msg)`
 * signature so a service can pass its own logger straight through.
 */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface LoadSecretsOptions {
  /** Universal Auth client id. Defaults to process.env.INFISICAL_CLIENT_ID. */
  clientId?: string;
  /** Universal Auth client secret. Defaults to process.env.INFISICAL_CLIENT_SECRET. */
  clientSecret?: string;
  /** Infisical project id. Defaults to process.env.INFISICAL_PROJECT_ID. */
  projectId?: string;
  /** Environment slug. Defaults to process.env.INFISICAL_ENV ?? 'prod'. */
  environment?: string;
  /** Secret folder path. Defaults to process.env.INFISICAL_SECRET_PATH ?? '/'. */
  secretPath?: string;
  /** Self-hosted Infisical URL. Defaults to process.env.INFISICAL_SITE_URL (else SDK default). */
  siteUrl?: string;
  /** Pull nested folders too. Defaults to process.env.INFISICAL_RECURSIVE. */
  recursive?: boolean;
  /** Abort (throw) on missing config or fetch failure. Defaults to process.env.INFISICAL_REQUIRED. */
  required?: boolean;
  /** Overwrite vars already present in process.env. Default false (backfill only). */
  overwrite?: boolean;
  /** Structured logger; defaults to a minimal console logger. */
  logger?: Logger;
}

export interface LoadSecretsResult {
  /** True only when secrets were successfully fetched from Infisical. */
  loaded: boolean;
  /** Number of keys actually injected into process.env. */
  injected: number;
  /** Where the effective config ultimately comes from. */
  source: "infisical" | "env";
}

export interface RefreshSecretsResult extends LoadSecretsResult {
  /** ISO timestamp of when the refresh completed. */
  refreshedAt: string;
}

export interface RefreshSecretsOptions extends LoadSecretsOptions {
  /** Called after every successful or failed refresh attempt. */
  onRefresh?: (result: RefreshSecretsResult) => void;
}
