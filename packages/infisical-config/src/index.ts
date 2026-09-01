// @quantum-l9/infisical-config — shared Infisical secret loader.
// Consumers: `import { loadSecrets, refreshSecrets, installSighupReload, startRefreshInterval } from '@quantum-l9/infisical-config'`
export {
  envFlag,
  installSighupReload,
  loadSecrets,
  refreshSecrets,
  startRefreshInterval,
} from "./secrets.js";
export type {
  LoadSecretsOptions,
  LoadSecretsResult,
  Logger,
  RefreshSecretsOptions,
  RefreshSecretsResult,
} from "./types.js";
