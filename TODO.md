# TODO — Deferred / externally-gated work


## Issue unblock (session reference)

**Cluster:** Quantum-L9/SEO-Bot#91
**Owning fix:** https://github.com/Quantum-L9/SEO-Bot/pull/96
**Next:** merge PR 96; confirm Gate 5 starts past getConfig
**Pickup:** Graphiti PICKUP written 2026-09-05

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

## 4. `gh-package-deps-preflight` — CLOSED (2026-08-31)

**Status:** fixed in `Quantum-L9/Cursor-Governance`. Was an open finding: the
governance gate hook, not this repository's code. Surfaced publishing the 4th
SQL-SEO contract, because that change edits `package.json` (adding the
test-group scripts) and the hook's `files:` guard matches `package.json`.

Two independent failures. Fixing either alone leaves the hook broken.

### It could not run here

The hook is defined in the governance `.pre-commit-config.yaml` with
`entry: python3 ops/scripts/validate_gh_package_deps.py` — a path relative to
whichever tree pre-commit runs in. `run_pr_precommit.sh` names the **governance**
config as its authority while running with the **consumer** workspace as cwd, so
the entry resolved to `<consumer>/ops/scripts/validate_gh_package_deps.py`, which
does not exist, and the hook died on a missing file rather than on anything it
checked:

```
can't open file '/home/user/seo-bot/ops/scripts/validate_gh_package_deps.py'
```

`_GOV_ONLY_SKIP` was already the mechanism for exactly this class — its comment
recorded the identical signature for `validate_commit_verification_contract.py`
— and the list was empty. `gh-package-deps-preflight` is now in it, so the hook
is skipped in a consumer checkout and still runs `--all-files` in governance.
The `files:` guard is not a defence: it decides *whether* the hook runs, the
entry path decides whether it *can*.

### It was also wrong about what it saw

Run manually against the governance interpreter it reported **8 findings**, two
per `@quantum-l9/*` package. The original entry called these "npm **workspace**
links"; they are not. This repo declares no `workspaces` key. All four are
`file:` protocol dependencies — `"@quantum-l9/bot-interop":
"file:packages/bot-interop"` — which npm records as `{"resolved":
"packages/bot-interop", "link": true}`: no tarball URL and no integrity, **by
construction**, not by omission. Every one of the hook's checks assumes a
registry install, so it read four correctly-vendored packages as eight defects.

`validate_gh_package_deps.py` now judges a `file:`/`link:` dep as a local dep.
The exemption is verified, not a skip: the declaration, the lock entry and the
directory on disk must agree, and that directory's `package.json` must name the
package it claims to be. `file:packages/ghost` is still a finding. Registry deps
are judged exactly as before — that is the PR #53 class the hook was written for.

`package-lock.json` remains byte-identical to `main`; no change on this branch
touched it, and none was needed.

### The second question this raised, still open

Whether these four packages are *meant* to be vendored, or consumed from GitHub
Packages, is a separate decision — the same one items §2 and "Adding Infisical"
below are waiting on. The hook no longer forces an answer by failing, which it
was never the right place to force.

---

## 5. Harvest from the `seo-bot-final-phase` pack (not integrated)

**Status:** open — ideas recorded, the pack's code deliberately NOT integrated.

A git bundle (`claude/seo-bot-final-phase-k1ikva`, 3 commits from 2026-08-31
17:44–23:10, based on `main@846fcc0`) arrived proposing a "staged-autonomy
control loop". It is a **second implementation of the intelligence plane this
repository already has**, built in parallel from `main` by an agent that could
not see the plane, because the plane is not on `main` yet — it is in the open
stack (#80, #81 and their parents).

**Why it was not integrated.** It is not complementary work:

| | Pack | This repo |
|---|---|---|
| Mode ladder | `off, observe, recommend, route_safe, route_llm, full` | identical |
| Signal types | 4 | 8 (superset; the pack's are earlier names — `bad_lcp_high_exit` for `high_exit_bad_lcp`, `citation_loss` split into two) |
| Opportunity types | 4 | 9 (superset) |
| `ModuleName` | adds `"intelligence"` | adds the same member |
| Migrations | claims `0002`, `0003` | already uses `0002`–`0005` |
| Module root | `src/modules/intelligence/` | `src/intelligence/` |

Eight files conflict textually, and the data layer is worse than a conflict:
both create `intelligence_runs`, `intelligence_signals`,
`intelligence_opportunities` and `intelligence_decisions` with **incompatible
columns** under `CREATE TABLE IF NOT EXISTS` — the pack's `signals` has
`subject`/`status`/`first_observed_at` and a nullable `run_id`, this repo's has
`entity_type`/`entity_id`/`confidence`/`suppressed_until` and `run_id NOT NULL`.
Run both against one database and the second silently no-ops; whichever ran
first wins and the other plane's inserts fail at runtime on missing NOT NULL
columns. Silent divergence, found in production.

Its one genuinely good refactor is already here: `link-building/safety.ts`
extracts the outreach caps to a pure leaf so the policy layer need not import a
module that builds LLM and mail clients at load time — which is exactly what
`src/modules/link-building/velocity.ts` already does, already consumed by
`src/intelligence/policy-state.ts`.

**Applied from it:** the `.gitignore` rule for `.claude/commands/` and
`.claude/skills/` (see this repo's `.gitignore`). Those were hidden only by
machine-local `.git/info/exclude`, so on any other checkout 76 generated files
appear untracked.

**Worth harvesting, each its own change against `src/intelligence/`:**

1. **`@electric-sql/pglite` as a test harness.** The pack runs its suite against
   an embedded Postgres in-process. That is a real alternative to gate 5's
   Docker/CI-services approach (`docs/seo-sql/TESTING.md`): no service
   containers, runnable in the default suite, at the cost of not being the same
   Postgres build production runs. The two are complementary — pglite could
   cover the SQL-shape assertions cheaply while gate 5 keeps the real-service
   verdict.
2. **`intelligence_action_links`.** The pack models the action→link relation as
   its own table. This repo threads that through `action_outcomes`; whether a
   dedicated link table is better is a schema question worth asking on its own.
3. **Exporting `SAFETY` from `link-building/index.ts`.** Not about missing
   constants: `SAFETY` already holds `minDomainRating`, `followUpDelayDays`,
   `maxFollowUps` and `circuitBreakerDropPct`, and it derives its two velocity
   caps from `LINK_VELOCITY` rather than restating them, so no cap is
   duplicated. What the pack's `safety.ts` offers is **reachability** — today
   `SAFETY` is `const`, module-private, inside a module that builds LLM, mail
   and database clients at load time, so nothing outside can read it without
   dragging those in. Worth doing when something outside the module needs one
   of the four; nothing does today.
4. **Exporting the Core Web Vitals thresholds** from
   `src/modules/web-vitals/index.ts`, where they are currently a private const.
   The pack extracts them to a pure leaf. No consumer needs that here today —
   the extractor reads `reporting.page_experience_risks` — so this is only worth
   doing when one does.

**Unblock trigger:** none — these are ordinary follow-ups. The pack itself needs
no decision; it is superseded and should not be merged.

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
