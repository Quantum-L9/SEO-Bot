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

## 3. `serp_and_answer_engine_loss` — CLOSED (2026-08-31)

**Status:** fixed. Was an open finding: a diagnosis that could never fire, with
a plan template, an evidence-pack allow-list entry and two grouping rules all
built on top of it, reading as working controls.

**Where:** `src/intelligence/signal-extractor.ts`
(`competitorCitationExtractor`), asserted in
`tests/intelligence/calibration.test.ts`.

### The finding

Both rules for this type require `keyword_drop` and a citation signal
(`competitor_citation_gain` or `citation_rate_down`) **in one group**. Grouping
is by `groupKey`, and the two sides keyed on disjoint dimensions:

| Signal | groupKey |
|---|---|
| `keyword_drop` | the ranking page path (`/roofing`), or `keyword:<kw>` when the URL is unknown |
| `citation_rate_down` | `platform:<name>` |
| `competitor_citation_gain` | `platform:<name>` |

A `platform:` key can never equal a path or a `keyword:` key, so the compound
rule had never matched and could not. The same input yielded the two
single-symptom diagnoses (`keyword_recovery` + `answer_engine_gap`) instead —
reasonable behavior, and why nothing looked wrong.

### What the original entry got wrong

It recorded this as a product decision blocked on data that did not exist:
"`aeo_citations` is aggregated per platform per month, carrying no keyword or
page dimension to join on." That describes the **extractor's rollup**, not the
table. `aeo_citations` has carried a per-row `query text NOT NULL` since
`drizzle/0000_steady_morlun.sql`; the per-platform aggregation is what discarded
it. The join the entry called for already existed in the schema.

### The fix

`competitorCitationExtractor` now emits at two scopes from one pass:

- **`platform`** — byte-identical to what shipped: `platform:<name>`, feeding
  `answer_engine_gap`. Per-platform targeting is untouched, which was the
  objection to re-keying citation signals onto a page.
- **`keyword`** — for queries that match a tracked keyword with a ranking drop
  in `reporting.keyword_drops_7d`, keyed exactly as `keywordDropExtractor` keys
  (the ranking page, else `keyword:<kw>`). This is what lets the compound rule
  form.

It stayed one extractor rather than becoming two because the registry test
asserts every signal type has exactly **one** producer — an invariant worth more
than the convenience of a second extractor.

Three properties make it work, and each is asserted on its mechanism rather than
on a score (a weights tweak would mask a score-based assertion):

1. the keyword scope's `groupKey` equals `keywordDropExtractor`'s, asserted
   against that extractor's own output so the two cannot drift apart;
2. the two scopes get **distinct** `entityId`s, so their fingerprints differ —
   a collision would make the signal cooldown treat them as one observation and
   blind whichever arrived second, restoring the bug with every other test green;
3. the keyword scope holds the same 5-position bar `keyword_drop` applies, so it
   cannot outlive the drop it pairs with.

Reversing any one of the three fails the suite. Verified by doing exactly that.

The scopes deliberately **overlap**: a citation lost on a dropping keyword still
counts toward its platform's aggregate. Excluding it would have silently
weakened `answer_engine_gap` — a real signal about overall answer-engine
presence — to make a bookkeeping property true.

### One thing this made visible, and did not change

The compound scores **27.43** where the single-symptom `keyword_recovery` on the
same drop scores **30.60**, so a compound diagnosis can sort below its own
component. That is the ROI formula working as written — it divides by
`effort + risk`, which is 7 for the compound and 5 for the recovery — not a
defect. Nobody could see it before, because the type never fired. Both clear the
threshold of 20, so the plane acts on either; changing `OPPORTUNITY_SHAPES`
weights to reorder them would reorder the whole portfolio and is a calibration
decision, not part of this fix.

**Related, and fixed earlier:** `link_outreach_batch` had the same shape — its
extractor capped severity at `medium`, worth 18 against a threshold of 20, so
outreach could never be proposed while the outreach flag, the velocity governor
and `route_safe`'s promise all guarded it.

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
