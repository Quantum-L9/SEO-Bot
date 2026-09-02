// @quantum-l9/infisical-config — shared Infisical secret loader.
// Consumers: `import { loadSecrets, refreshSecrets, installSighupReload, startRefreshInterval } from '@quantum-l9/infisical-config'`
export {
  decideSecretInject,
  envFlag,
  installSighupReload,
  isBlankEnvValue,
  loadSecrets,
  refreshSecrets,
  startRefreshInterval,
  unsetBlankProcessEnv,
} from "./secrets.js";
export type { SecretInjectDecision } from "./secrets.js";
export type {
  LoadSecretsOptions,
  LoadSecretsResult,
  Logger,
  RefreshSecretsOptions,
  RefreshSecretsResult,
} from "./types.js";
