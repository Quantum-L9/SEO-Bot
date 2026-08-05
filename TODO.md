# TODO — Deferred / externally-gated work

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

## 2. P4a — consume `@quantum-l9/infisical-config` (Infisical loader)

**Status:** coded; open as **draft PR #12**. CI red only because the package
isn't published yet.

**Unblock trigger:** `@quantum-l9/infisical-config` publishes to GitHub Packages
**and** this repo is granted package read →
- `npm install` in CI goes green,
- mark PR #12 ready-for-review,
- merge.

No code changes remain on this repo's side.

---

## 3. Wire `AgentBudgetGuard` to a live per-call USD cost signal

**Status:** deferred — class merged and unit-tested, not yet enforcing on a real
spend path.
**Where:** `src/core/budget-guard.ts` (the `AgentBudgetGuard` class).

`AgentBudgetGuard` implements the ADR-0008 USD admission → reserve → reconcile →
enforce loop with the documented mode thresholds, and has full unit coverage
(`tests/core/budget-guard.test.ts`). `CompensationRegistry` — the other half of
ADR-0008's runtime controls — **is** now wired and proven in
`serp:execute-surpass-plans` (see `tests/services/plan-executor.test.ts`, the
deploy-failure rollback saga).

**Deliberately NOT wired.** The guard needs a *real* per-call USD cost to
`reserve()`/`reconcile()` against. The surpass-plan executor path performs no
metered LLM spend of its own (its dispatchers are file edits + a Vercel deploy),
so wiring the guard there would require inventing per-action cost figures — an
unverified fabrication. The genuine USD signal lives in the LLM service
(`src/services/llm.ts` `getDailySpend()` / the router cost log), which is a
different, un-audited integration seam.

**Unblock trigger:** a metered high-cost job handler exposes real per-call USD
(e.g. the gap-analysis/LLM generation path threads `router` call costs into a
per-job guard) **or** the approved remediation plan specifies the exact seam →
then `open()` at admission, `reserve()` before each LLM call, `reconcile()` on
each response, and persist `budget_violations` / `agent_jobs` rows for evidence.

**Interim safety:** per-run token limits are still enforced by the existing
`TokenBudget` circuit breaker in `src/core/scheduler.ts` (RUNBOOK Scenario A).

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
