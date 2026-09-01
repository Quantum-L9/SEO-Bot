<!-- L9_META: layer=documentation, role=seo_sql_contract_ledger, status=active, version=3.0.0 -->
# SEO SQL — contract ledger

Where work on the SEO SQL planes goes, and what has been built.

**Contracts C1–C6 are delivered.** What follows records what each one did and the
constraints that survive it, so a later change knows what it is allowed to
renegotiate. The "where future work goes" table at the bottom is the live part.

| Plane | ADR | Code |
|---|---|---|
| Reporting SQL plane | [ADR-0015](../../adr/ADR-0015-reporting-sql-plane.md) | `drizzle/0002`, `0004`, `0005`, `src/reporting/`, `src/api/reporting.ts` |
| Intelligence plane | [ADR-0016](../../adr/ADR-0016-intelligence-plane.md) | `drizzle/0003`, `src/intelligence/` |
| Testing contract | [TESTING.md](TESTING.md) | `tests/migrations/`, `tests/intelligence/`, `scripts/intelligence/` |

---

## Delivered

### C3 — Opportunity lifecycle and approved-action attribution

Two live defects, both closed.

`intelligence_opportunities.status` never transitioned, so an unbounded
`status = 'open'` duplicate lookup matched every opportunity ever recorded and
suppression was permanent. Transitions now: `open` → `actioned` on a logged
proposal, → `resolved` on a measured `improved`, → `expired` after
`INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS` without recurrence. **`declined` and
`unchanged` REOPEN** — a remedy that did not work leaves the problem in place.
Suppression keys off `open`/`actioned`; the cooldown bound that stood in for a
lifecycle is gone.

An operator-approved CRITICAL action went nowhere. `intel:lifecycle-sweep`
(hourly, zero-token) now gives it the outcome row, attribution window and
follow-up job an auto-executed one gets, claiming each row with a conditional
`executed_at` stamp so a retried sweep cannot double-count.

**Do not renegotiate:** expiry must outlast the signal cooldown
(`assertLifecycleConfig`); only a measured improvement closes an opportunity.

### C6 — Testing contract

Full detail in [TESTING.md](TESTING.md); the gates, the mode table and the
production-readiness checklist live there. What belongs in the ledger is what
the testing pass found, because each finding is a shape the next contract can
repeat.

**Every control tested green while guarding nothing.** Three defects, one
pattern: a control whose own logic was correct, protecting a path that either
went nowhere or was not the path being taken.

- `link_outreach_batch` could never be proposed. Its extractor capped severity
  at `medium`, worth 18 against a threshold of 20 — so the outreach allow-flag,
  the velocity governor, `OUTREACH_FOLLOW_UP_JOBS` and `route_safe`'s explicit
  promise all guarded a road with nothing on it. Fixed with a `high` rung keyed
  on the CONTACTABLE subset.
- `off` was not off in the runner. Enforced at registration, which covers steady
  state — but a repeatable job already in Redis, an in-flight retry, and a
  manual trigger all re-enter `runClientTriage` directly, where the run and its
  rows were written regardless of mode. `reason` was on the capability surface
  for exactly this and never consulted.
- The follow-up enqueue's dedup key was derived from the `action_outcomes` row,
  inserted fresh on every pass, so it deduplicated nothing. Suppression already
  covered the retry its comment claimed; nothing covered the concurrent-run race.
  Now keyed on the opportunity fingerprint.

Plus one outside the plane: `clients.config` was served whole by the client read
routes, carrying `site_deployment.githubToken` and `vercelDeployHook`. The
column allow-list that excluded `posthog_api_key` could not see inside a JSONB
blob.

**That finding is now closed.** `serp_and_answer_engine_loss` was structurally
unreachable — its grouping rules need `keyword_drop` and a citation signal in
one group, and every citation signal keyed on `platform:<name>` while
`keyword_drop` keyed on a page or `keyword:<kw>`. It was recorded as a product
decision waiting on new data. That was the wrong read: `aeo_citations` has
always carried a per-row `query`, and only the per-platform rollup discarded it.
`competitorCitationExtractor` now emits a second, keyword-scoped signal for
queries that match a tracked keyword's ranking drop, keyed exactly as
`keywordDropExtractor` keys — so the compound rule forms. No migration, and the
platform scope is unchanged, so `answer_engine_gap` keeps its per-platform
targeting. Still asserted on the mechanism rather than on a score.

**Do not renegotiate:** the static gates are gates, not advice — an applied
migration's checksum, the env-var declaration rule, and the additive-migration
marker each exist because the alternative was a reviewer noticing by eye. The
verification pack stays read-only and stays phrased so rows mean a violation. A
query that errors is a finding, never a pass.

### C1 — Portfolio benchmarking plane

`reporting.portfolio_benchmarks` (migration 0004): p25/p50/p75 for position,
LCP, exit rate and citation rate over industry × country × state × month.

**The k-anonymity floor of 5 applies at two levels**, and the second is the one
easy to omit: a row-level `HAVING count(DISTINCT client_id) >= 5`, AND a
per-metric guard, because a cohort can hold five clients while only two have
vitals data. `plane-contract.test.ts` reads the migration's literals back.

`seo_benchmark_reporting` no longer holds the per-tenant matview grants it had
before there was anything benchmark-shaped to read.

**Do not renegotiate:** the floor, or either level of it. Lowering it is a
migration and a privacy decision.

### C2 — Evidence-pack consumer

`intel:synthesize-plans` — the plane's only budgeted job. The model **ranks
actions the pack already permits**; a response naming anything else is rejected
whole. It runs over proposals awaiting an operator's approval, and the
auto-executed path stays template-chosen — see the ADR-0016 amendment for why,
and what changing it would cost.

**Do not renegotiate:** the model never authors an action string; risk labels
come from the execution policy, not the model; every failure path leaves the
deterministic proposal untouched.

### C4 — Operator dashboard surface

`/dashboard/intelligence`: open work by score, decisions with rationale, windows
counting down, measured outcomes, snapshot age inline. Reads through the
reporting gateway (migration 0005 adds the views) rather than the tables, so it
is audited, read-only and timeout-bounded like every other consumer. A failing
panel degrades in place.

**Do not renegotiate:** the dashboard does not query the intelligence tables
directly, and every model-authored value (`rationale`, `hypothesis`,
`learnings`, `title`) is escaped at the render site.

### C5 — Rollout ladder and install hardening

The plane could reason end-to-end and had no way to be enabled in stages, so
turning it on was a deploy rather than a cutover. `INTELLIGENCE_MODE` is that
staging: `off` → `observe` → `recommend` → `route_safe` → `route_llm` → `full`,
each rung a superset of the one before, defaulting to `off`.

**Two capabilities sit outside the ladder** behind their own flags —
`INTELLIGENCE_ALLOW_OUTREACH_ROUTING` and `INTELLIGENCE_ALLOW_SITE_MUTATION`.
Both are irreversible, and an operator raising the mode for better ranking must
not thereby acquire the right to email a stranger. `full` grants neither.

The gate is applied at registration (a disabled job cannot fire and then
decline), on the execution **decision** before `logAction` (so `action_log` never
records a withheld action as executed), and again at the queue itself.

Three install defects closed alongside, each silent:

- `cmd_update` never migrated — only `setup` did, so a release carrying a
  migration booted new code against an old schema.
- `deploy.sh` addressed Compose by `container_name`, which matches no service
  and exits 0.
- `addJob` had no deduplication key, so a retried follow-up enqueue sent the
  same outreach twice.

An unknown action from a composed origin now fails closed to
critical/irreversible. Keyed on `triggeredBy`, **not** `module`: an intelligence
proposal carries the module that will execute it, so a module-keyed check is
dead code that looks like a control.

**Do not renegotiate:** the ladder is monotonic (asserted across every mode);
outreach and site mutation each need the routing rung AND their own flag;
`INTELLIGENCE_LLM_PLANNING_ENABLED` stays decisive at every mode;
`reporting:refresh-materialized` is never gated on the intelligence mode;
rollback is one environment variable plus a restart.

---

## Working agreement

**Stack, do not fan out.** Work on these planes concentrates in
`src/intelligence/` and `src/reporting/`; parallel sibling branches off `main`
will conflict. Work sequentially on one branch, or stack a child branch per
change on the previous one's head (`PR_STACK=auto`; bottom-up merge order).

**Boundaries that do not move.** These are not C1–C4's to renegotiate:
- The intelligence plane proposes; it never writes to a client site.
- `serp:execute-surpass-plans` stays off `TRIGGERABLE_JOBS` (AGENTS §9).
- The execution policy's auto-execute band and CRITICAL classification are
  unchanged without operator sign-off.
- Agent-audience projections never gain client identity or contact PII — nor
  model-authored free text, which quotes the evidence it reasoned over.
- The k-anonymity floor holds at both the cohort and the per-metric level.
- The intelligence plane's reasoning jobs stay zero-token; only
  `intel:synthesize-plans` may spend, and `registration.test.ts` pins that as a
  list of one.
- No migration creates a role or embeds a password.

**Gate.** `npx tsc --noEmit && npx vitest run`, both green with output shown.
Add a migration with `npx drizzle-kit generate` or by hand following
`0002`/`0003`; never edit an applied migration; register it in
`drizzle/meta/_journal.json` with a strictly increasing `when` **and in
`drizzle/CHECKSUMS.json`** — the static gate fails on either being absent.
Narrower loops while working: `npm run test:intelligence`,
`npm run test:reporting`, `npm run test:gates`, `npm run test:api`. Against a
real database, `npm run verify:intelligence`. Full gate map: [TESTING.md](TESTING.md).

**Publish.** `python3 ops/autonomy/l4_local.py begin --contract-id "<id>"` →
`authorize-release` → `PR_REMEDIATE=0 make pr`. Do not raw-push.

---

## Where future work goes

| Kind of work | Destination | Rule |
|---|---|---|
| A new question to ask the data | `src/reporting/views.ts` | Registry entry + migration view. Never an ad-hoc query. `plane-contract.test.ts` checks the registry against **every** reporting migration — add a new one to its list. |
| A new thing the bot should notice | `src/intelligence/signal-extractor.ts` | Needs an extractor **and** a grouping rule in `opportunity-scorer.ts` — a test enforces the pairing, or the signal is recorded and never acted on. |
| A new remedy the bot may propose | `src/intelligence/action-planner.ts` | Must be in the evidence-pack allow-list for its opportunity type and on `TRIGGERABLE_JOBS`. Both asserted at import. |
| A new lifecycle transition | `src/intelligence/lifecycle.ts` | Guard the update on the status it transitions FROM; an unguarded transition walks a terminal opportunity backwards on a retried job. |
| A new cross-client statistic | `drizzle/0006+` | Guard the cohort AND each metric at the k-anonymity floor. |
| Anything that spends tokens | Its own budgeted job | Add it to `BUDGETED` in `registration.test.ts` — the zero-token invariant is a named list, so a new spender has to be declared. |
| A new operator panel | `src/api/dashboard.ts` via the reporting gateway | Not direct table queries. Escape every DB value; `rationale`, `hypothesis` and `learnings` are model-authored free text. |
| Schema change | `drizzle/0006+` | Hand-written following `0004`/`0005`; register in `_journal.json` with a strictly increasing `when`. **Never edit an applied migration.** |
| A new signal type or opportunity type | its extractor + `calibration.test.ts` | Add a worst-case fixture, or an entry in `UNREACHABLE` with the reason. A type with neither is a type nobody checked — which is how `link_outreach_batch` shipped unreachable. |
| A new post-run invariant | `scripts/intelligence/verify-invariants.ts` | Phrase it so ROWS MEAN A VIOLATION, give it a `meaning` an operator can act on at 3am, and keep it read-only. The test checks it against the migrations. |
| A new environment variable | `src/core/config.ts` **and** `.env.example` | Both, or the static gate fails. A `process.env` read outside config.ts needs a named exemption with its reason. |
| Editing a migration that already applied | don't — add `drizzle/0006+` | `drizzle/CHECKSUMS.json` will fail the suite. If it genuinely never shipped, update the checksum in the same commit. |
| A new capability the plane may exercise | `src/intelligence/mode.ts` | Add it to the ladder or to an out-of-ladder flag — never both, and never as a bare `mode !== "off"` check at the call site. The monotonicity test covers every mode automatically. |
| A new follow-up job the plane may queue | `src/intelligence/mode.ts` sets | Classify it as outreach or site-mutating if it is either, or it routes at `route_safe` — the one thing that rung promises it will not do. |
| A new enqueue made from a durable row | its call site | Pass `addJob`'s `jobId`, derived from the row. BullMQ is at-least-once; without a key a retry duplicates the work. |
