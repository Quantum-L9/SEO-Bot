import type { LoadSecretsOptions, LoadSecretsResult, RefreshSecretsOptions, RefreshSecretsResult } from "./types.js";
/** Parse a loose boolean env var ('1' / 'true', case-insensitive). */
export declare function envFlag(value: string | undefined): boolean;
/** True when a process.env / vault value is missing or only whitespace. */
export declare function isBlankEnvValue(value: string | undefined): boolean;
/**
 * Delete `KEY=` / `KEY=""` placeholders from an env object.
 * `.env` templates and empty Infisical rows are unset, not "set to empty" —
 * Infisical backfill of required secrets (`L9_MEMORY_TOKEN`) needs that.
 */
export declare function unsetBlankProcessEnv(env?: NodeJS.ProcessEnv): string[];
export type SecretInjectDecision = "inject" | "skip-existing" | "skip-blank";
/** Decide whether a vault row should land in process.env. */
export declare function decideSecretInject(existing: string | undefined, incoming: string, overwrite: boolean): SecretInjectDecision;
/**
 * Hydrate process.env from Infisical (https://infisical.com) via a machine
 * identity (Universal Auth). Designed to be called once, before configuration
 * is read/validated.
 *
 *  - OPTIONAL: no-op when client id / secret / project id are all absent —
 *    falls back to process.env exactly as before. Nothing breaks locally.
 *  - NON-DESTRUCTIVE: never overwrites an already-set nonempty var (unless
 *    `overwrite`), so an explicit shell/systemd export or a local .env still
 *    wins. Blank `KEY=` placeholders are unset first — they are not values.
 *  - BLANK VAULT ROWS: empty Infisical values are not injected (and leftover
 *    blanks are deleted) so Infisical can backfill `L9_MEMORY_TOKEN`.
 *  - FAIL-SOFT by default; `required` (or INFISICAL_REQUIRED=true) makes it a
 *    hard dependency that throws on missing config or fetch failure.
 *  - @infisical/sdk is imported lazily, so it's only resolved when configured.
 *
 * Every option falls back to its INFISICAL_* environment variable, so a
 * zero-arg `loadSecrets()` behaves purely off the environment.
 */
export declare function loadSecrets(options?: LoadSecretsOptions): Promise<LoadSecretsResult>;
/**
 * Re-fetch secrets from Infisical and overwrite process.env with fresh values.
 *
 * Designed for two use cases:
 *  1. SIGHUP-driven reload — call `installSighupReload()` to wire this up.
 *  2. Interval-driven polling — pass `intervalMs` to return a timer handle.
 *
 * Always calls loadSecrets with `overwrite: true` so rotated values replace
 * stale ones in process.env (the critical difference from the initial boot call).
 *
 * Returns a RefreshSecretsResult with a `refreshedAt` ISO timestamp so callers
 * can track when the last successful refresh occurred.
 */
export declare function refreshSecrets(options?: RefreshSecretsOptions): Promise<RefreshSecretsResult>;
/**
 * Install a SIGHUP handler that calls refreshSecrets() with the given options.
 *
 * Follows the systemd `ExecReload=kill -HUP $MAINPID` pattern — infra's
 * rotation-reload.timer sends SIGHUP after re-issuing the client secret,
 * and this handler re-auths and re-hydrates process.env without restarting.
 *
 * Returns an uninstall function that removes the listener when called.
 *
 * Usage (at service entrypoint, after initial loadSecrets):
 *   const uninstall = installSighupReload({ logger });
 *   // on graceful shutdown:
 *   uninstall();
 */
export declare function installSighupReload(options?: RefreshSecretsOptions): () => void;
/**
 * Start an interval-based secret refresh loop.
 *
 * Fires immediately on first call, then repeats every `intervalMs`.
 * Use as a belt-and-suspenders complement to SIGHUP reload — the interval
 * ensures stale secrets are caught even without an explicit reload signal.
 *
 * Keep intervalMs shorter than the Infisical rotation overlap window to
 * guarantee every instance re-fetches before the old credential is revoked.
 *
 * Returns a NodeJS.Timer handle. Call clearInterval(handle) to stop.
 */
export declare function startRefreshInterval(intervalMs: number, options?: RefreshSecretsOptions): ReturnType<typeof setInterval>;
//# sourceMappingURL=secrets.d.ts.map