/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * Thin adapter over `@quantum-l9/infisical-config`.
 * Same fleet contract as Website-Bot ADR-0009: Universal Auth bootstrap
 * (`INFISICAL_CLIENT_ID` / `_SECRET` / `_PROJECT_ID`), fail-soft unless
 * `INFISICAL_REQUIRED=true`, never overwrite caller-set env (overwrite:false).
 */

import {
  loadSecrets as loadInfisicalSecrets,
  type LoadSecretsOptions,
  type LoadSecretsResult,
} from '@quantum-l9/infisical-config';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('secrets');

export type { LoadSecretsResult };

export type SourceMode = 'process_env_only' | 'infisical_hydrated' | 'infisical_unavailable';

export type HydrateSecretsMetadata = {
  bootstrap_present: boolean;
  source_mode: SourceMode;
  result: LoadSecretsResult;
};

function bootstrapPresent(): boolean {
  return Boolean(
    process.env.INFISICAL_CLIENT_ID
      && process.env.INFISICAL_CLIENT_SECRET
      && process.env.INFISICAL_PROJECT_ID,
  );
}

/** Hydrate process.env from Infisical (fail-soft unless INFISICAL_REQUIRED=true). */
export async function loadSecrets(
  options: LoadSecretsOptions = {},
): Promise<LoadSecretsResult> {
  // Never overwrite caller-set vars (Actions env / local .env overrides win).
  return loadInfisicalSecrets({ logger, overwrite: false, ...options });
}

/**
 * Website-Bot-parity entry helper: load when bootstrap is present and return
 * provenance metadata (never secret values).
 */
export async function hydrateSecretsIfConfigured(
  options: LoadSecretsOptions = {},
): Promise<HydrateSecretsMetadata> {
  const present = bootstrapPresent();
  const result = await loadSecrets(options);

  let source_mode: SourceMode;
  if (!present) {
    source_mode = 'process_env_only';
  } else if (result.loaded) {
    source_mode = 'infisical_hydrated';
  } else {
    source_mode = 'infisical_unavailable';
  }

  if (present) {
    logger.info(
      { source_mode, injected: result.injected, source: result.source },
      'Infisical secrets hydrate',
    );
  }

  return { bootstrap_present: present, source_mode, result };
}
