/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * Thin adapter over `@quantum-l9/infisical-config`.
 * Keeps SEO-Bot logger wiring while the shared package owns Infisical UA + hydration.
 * See Website-Bot ADR-0009 for the fleet secrets-plane contract.
 */

import { loadSecrets as loadInfisicalSecrets, type LoadSecretsResult } from '@quantum-l9/infisical-config';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('secrets');

export type { LoadSecretsResult };

/** Hydrate process.env from Infisical (fail-soft unless INFISICAL_REQUIRED=true). */
export async function loadSecrets(): Promise<LoadSecretsResult> {
  return loadInfisicalSecrets({ logger });
}
