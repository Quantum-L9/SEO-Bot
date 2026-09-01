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

## 3. `serp_and_answer_engine_loss` is a diagnosis that can never fire

**Status:** open finding — asserted in `tests/intelligence/calibration.test.ts`,
not fixed. Found by the 4th SQL-SEO contract (testing) while checking every
actionable opportunity type against the action threshold through its REAL
extractors rather than through hand-built signals.

**Where:** `src/intelligence/opportunity-scorer.ts` (`GROUPING_RULES`),
`src/intelligence/signal-extractor.ts` (the three extractors' group keys).

Both rules for this type require `keyword_drop` and a citation signal
(`competitor_citation_gain` or `citation_rate_down`) **in one group**. Grouping
is by `groupKey`, and the two sides key on disjoint dimensions by construction:

| Signal | groupKey |
|---|---|
| `keyword_drop` | the ranking page path (`/roofing`), or `keyword:<kw>` when the URL is unknown |
| `citation_rate_down` | `platform:<name>` |
| `competitor_citation_gain` | `platform:<name>` |

A `platform:` key can never equal a path or a `keyword:` key, so the compound
rule has never matched and cannot. Today the same input yields the two
single-symptom diagnoses (`keyword_recovery` + `answer_engine_gap`) instead —
which is reasonable behavior, and is why nothing looked wrong.

What makes it worth tracking is the surface built on top of it: a plan template,
an evidence-pack action allow-list entry and two grouping rules all exist for a
remedy that never fires. They read as working controls.

**Why it is not fixed here.** Every candidate fix is a product decision, not a
calibration one. Re-keying citation signals to a page would break the
per-platform targeting `answer_engine_gap` depends on; making the classifier
join across groups changes what "an opportunity" means; deleting the rules and
the template removes a declared capability. The natural join is keyword ↔ the
citation's sampled query, and `aeo_citations` is aggregated per platform per
month, carrying no keyword or page dimension to join on.

**Unblock trigger:** a decision on whether the compound diagnosis is wanted. If
yes, it needs the citation aggregation to carry a keyword/page dimension, then
move the type from `UNREACHABLE` into `WORST_CASE` in `calibration.test.ts`. If
no, delete both grouping rules, the plan template and the allow-list entry — the
runtime behavior is identical either way, since the rule never fires.

**Related, and fixed:** `link_outreach_batch` had the same shape — its extractor
capped severity at `medium`, worth 18 against a threshold of 20, so outreach
could never be proposed while the outreach flag, the velocity governor and
`route_safe`'s promise all guarded it. That one was a calibration oversight with
a local fix (a `high` rung on a large contactable batch) and is closed.

---

## 4. `gh-package-deps-preflight` cannot run in a consumer workspace

**Status:** open finding — the governance gate hook, not this repository's code.
Surfaced while publishing the 4th SQL-SEO contract, because that change edits
`package.json` (adding the test-group scripts) and the hook's `files:` guard
matches `package.json`.

The hook is defined in the governance `.pre-commit-config.yaml` with
`entry: python3 ops/scripts/validate_gh_package_deps.py` — a path relative to
the **governance** tree. Run against a consumer workspace it resolves to
`<consumer>/ops/scripts/validate_gh_package_deps.py`, which does not exist, and
the hook dies on a missing file rather than on anything it checked:

```
can't open file '/home/user/seo-bot/ops/scripts/validate_gh_package_deps.py'
```

`ops/scripts/run_pr_precommit.sh` already has the mechanism for exactly this
class — `_GOV_ONLY_SKIP`, whose comment records the identical failure signature
for `validate_commit_verification_contract.py` — but the list is currently
empty, so this hook is not in it.

**Run manually against the governance interpreter, it reports 8 findings**, all
pre-existing and none caused by any change here: the four `@quantum-l9/*`
packages resolve to `packages/<name>` with `"link": true`, because they are npm
**workspace links** in this repo's layout, and the hook expects hash-suffixed
GitHub Packages tarballs with sha512 integrity. `package-lock.json` is
byte-identical to `main`; no change on this branch touches it.

**Unblock trigger:** add `gh-package-deps-preflight` to `_GOV_ONLY_SKIP` in
`Quantum-L9/Cursor-Governance` (`ops/scripts/run_pr_precommit.sh`), so the hook
is skipped in a consumer checkout and still runs `--all-files` in the governance
repo. Separately, decide whether the hook should recognise npm workspace links
as legitimate, or whether these four packages are meant to be consumed from
GitHub Packages here — the second question is the same one the Infisical items
above are waiting on.

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
