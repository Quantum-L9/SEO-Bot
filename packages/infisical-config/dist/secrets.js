/** Fallback logger when a service doesn't pass its own. Quiet by default. */
const consoleLogger = {
    info: (obj, msg) => console.info(msg ?? "", obj ?? ""),
    warn: (obj, msg) => console.warn(msg ?? "", obj ?? ""),
    debug: (obj, msg) => {
        if (process.env.DEBUG)
            console.debug(msg ?? "", obj ?? "");
    },
};
/** Parse a loose boolean env var ('1' / 'true', case-insensitive). */
export function envFlag(value) {
    return value === "1" || value?.toLowerCase() === "true";
}
/** True when a process.env / vault value is missing or only whitespace. */
export function isBlankEnvValue(value) {
    return value === undefined || value.trim() === "";
}
/**
 * Delete `KEY=` / `KEY=""` placeholders from an env object.
 * `.env` templates and empty Infisical rows are unset, not "set to empty" —
 * Infisical backfill of required secrets (`L9_MEMORY_TOKEN`) needs that.
 */
export function unsetBlankProcessEnv(env = process.env) {
    const removed = [];
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string" && value.trim() === "") {
            delete env[key];
            removed.push(key);
        }
    }
    return removed;
}
/** Decide whether a vault row should land in process.env. */
export function decideSecretInject(existing, incoming, overwrite) {
    if (isBlankEnvValue(incoming))
        return "skip-blank";
    if (overwrite || isBlankEnvValue(existing))
        return "inject";
    return "skip-existing";
}
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
export async function loadSecrets(options = {}) {
    const log = options.logger ?? consoleLogger;
    const clientId = options.clientId ?? process.env.INFISICAL_CLIENT_ID;
    const clientSecret = options.clientSecret ?? process.env.INFISICAL_CLIENT_SECRET;
    const projectId = options.projectId ?? process.env.INFISICAL_PROJECT_ID;
    const required = options.required ?? envFlag(process.env.INFISICAL_REQUIRED);
    const overwrite = options.overwrite ?? false;
    const cleared = unsetBlankProcessEnv();
    if (cleared.length > 0) {
        log.debug({ cleared: cleared.length }, "Cleared blank process.env placeholders before hydrate");
    }
    // Not configured → no-op fallback to process.env.
    if (!clientId || !clientSecret || !projectId) {
        if (required) {
            throw new Error("INFISICAL_REQUIRED is set but client id, client secret and project id are not all provided.");
        }
        // Partial config is almost always a deploy misconfiguration — surface it.
        if (clientId || clientSecret || projectId) {
            log.warn({
                hasClientId: Boolean(clientId),
                hasClientSecret: Boolean(clientSecret),
                hasProjectId: Boolean(projectId),
            }, "Infisical partially configured — need client id, client secret and project id; skipping Infisical");
        }
        else {
            log.debug({}, "Infisical not configured — using process.env only");
        }
        return { loaded: false, injected: 0, source: "env" };
    }
    const environment = options.environment ?? process.env.INFISICAL_ENV ?? "prod";
    const secretPath = options.secretPath ?? process.env.INFISICAL_SECRET_PATH ?? "/";
    const siteUrl = options.siteUrl ?? process.env.INFISICAL_SITE_URL;
    const recursive = options.recursive ?? envFlag(process.env.INFISICAL_RECURSIVE);
    try {
        // Lazy import: the SDK is only loaded when Infisical is configured.
        const { InfisicalSDK } = await import("@infisical/sdk");
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
            const decision = decideSecretInject(process.env[secret.secretKey], secret.secretValue ?? "", overwrite);
            if (decision === "skip-blank") {
                delete process.env[secret.secretKey];
                continue;
            }
            if (decision === "inject") {
                process.env[secret.secretKey] = secret.secretValue;
                injected++;
            }
        }
        log.info({ environment, secretPath, fetched: secrets.length, injected }, "Loaded secrets from Infisical");
        return { loaded: true, injected, source: "infisical" };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (required) {
            throw new Error(`Infisical secret load failed (required): ${message}`);
        }
        log.warn({ error: message }, "Infisical secret load failed — continuing with process.env");
        return { loaded: false, injected: 0, source: "env" };
    }
}
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
export async function refreshSecrets(options = {}) {
    const log = options.logger ?? consoleLogger;
    log.debug({}, "refreshSecrets: starting re-fetch with overwrite=true");
    const result = await loadSecrets({ ...options, overwrite: true });
    const refreshResult = {
        ...result,
        refreshedAt: new Date().toISOString(),
    };
    if (result.loaded) {
        log.info({ injected: result.injected, refreshedAt: refreshResult.refreshedAt }, "refreshSecrets: secrets refreshed from Infisical");
    }
    else {
        log.warn({ source: result.source, refreshedAt: refreshResult.refreshedAt }, "refreshSecrets: re-fetch skipped or failed — process.env unchanged");
    }
    options.onRefresh?.(refreshResult);
    return refreshResult;
}
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
export function installSighupReload(options = {}) {
    const log = options.logger ?? consoleLogger;
    const handler = () => {
        log.info({}, "SIGHUP received — refreshing secrets from Infisical");
        refreshSecrets(options).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ error: msg }, "refreshSecrets on SIGHUP failed");
        });
    };
    process.on("SIGHUP", handler);
    log.debug({}, "SIGHUP reload handler installed");
    return () => {
        process.off("SIGHUP", handler);
        log.debug({}, "SIGHUP reload handler removed");
    };
}
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
export function startRefreshInterval(intervalMs, options = {}) {
    const log = options.logger ?? consoleLogger;
    log.info({ intervalMs }, "Starting Infisical secret refresh interval");
    // Fire immediately, then on interval
    void refreshSecrets(options);
    return setInterval(() => {
        void refreshSecrets(options);
    }, intervalMs);
}
//# sourceMappingURL=secrets.js.map