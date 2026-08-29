# TODO — Deferred / externally-gated work


## Issue unblock (session reference)

**Cluster:** Quantum-L9/Website-Bot#167 + Quantum-L9/SEO-Bot#73 (bot-interop 1.2.0)
**Owning fix:** Website-Bot tag `bot-interop-v1.2.0` @ d670319 (published); this branch `package-lock.json` now resolves 1.2.0
**Next:** hand SEO-Bot#72 to l9-pr-remediation for CI green after lockfile push
**Pickup:** Graphiti PICKUP written 2026-08-29

Tracked items that are intentionally **not** done yet because they depend on an
operational or external precondition (not on more code). Each lists the exact
trigger that unblocks it.

---

## 1. Enable multi-tenant `serp:execute-surpass-plans` (the enable-flip)

**Status:** deferred — code merged, job still `enabled: false`.
**Where:** `src/core/scheduler.ts` (the `serp:execute-surpass-plans` job definition).

The multi-tenant `site_deployment` wiring is fully merged: each client's
autonomous surpass-plan edits resolve their own repo / deploy hook via
`siteConfigFromClient(job.data.clientConfig)`, and safety is enforced at that
boundary — any absent or blank github token / target repo (plus the
`NODE_ENV`/`SITE_DEPLOY_DRY_RUN` kills) forces `dryRun: true`, so an
unconfigured client is a true no-op (no outbound GitHub call).

**Deliberately NOT flipped.** The plan gates the `enabled: false → true` flip
behind an operational precondition, not code: **real per-client
`config.site_deployment` must exist in the DB** (set via `scripts/add-client.ts`).
Because safety is enforced at the `siteConfigFromClient` boundary, flipping it
later is safe-by-construction once that config exists.

**Unblock trigger:** real per-client `site_deployment` config is populated in
`clients.config` for the tenants that should write live → then flip
`enabled: false → true` (its own small PR, separate from the code merge) and
redeploy.

**Rollback:** flip `enabled: true → false`, redeploy, confirm no job re-enqueues
next cycle, and audit recent `gapAnalyses` rows at `status='executing'`.

---

## 2. P4a — consume `@quantum-l9/infisical-config` (DONE 2026-08-11) (Infisical loader)

**Status:** coded; open as **draft PR #12**. CI red only because the package
isn't published yet.

**Unblock trigger:** `@quantum-l9/infisical-config` publishes to GitHub Packages
**and** this repo is granted package read →
- `npm install` in CI goes green,
- mark PR #12 ready-for-review,
- merge.

No code changes remain on this repo's side.

---

## Related (other repo)

- **P4b — Website-Bot `infisical run` wrap:** see `TODO.md` in `Quantum-L9/Website-Bot`.
  Gated on the Infisical project being provisioned (`terraform apply`), secret
  values populated, and the 3 `INFISICAL_*` bootstrap vars set as Actions secrets.

Both P4a and P4b are downstream of the **handoff pushes** (`infra` +
`infisical-config` repos).

---

## Adding Infisical (outstanding)

**Decision (2026-07-20):** PR #12 was reverted to keep the local
`src/core/secrets.ts` loader so SEO-Bot no longer imports the unpublished
`@quantum-l9/infisical-config` package — this turns #12's CI green. Consuming
the shared package is deferred, not done.

**To actually add Infisical, do the handoff work first (other repo,
`Quantum-L9/infisical-config`):**
- publish `@quantum-l9/infisical-config@1.0.0` to GitHub Packages, and grant
  this repo package-read access;
- then re-apply the P4a swap here (import `loadSecrets` from the package, delete
  the inline loader + its test, drop the direct `@infisical/sdk` dependency);
- run CI to confirm `npm install` resolves the package and stays green.
