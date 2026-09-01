<!-- L9_META: layer=documentation, role=seo_sql_contract_ledger, status=active, version=2.0.0 -->
# SEO SQL — contract ledger

Where work on the SEO SQL planes goes, and what has been built.

**All four contracts C1–C4 are delivered.** What follows records what each one
did and the constraints that survive it, so a later change knows what it is
allowed to renegotiate. The "where future work goes" table at the bottom is the
live part.

| Plane | ADR | Code |
|---|---|---|
| Reporting SQL plane | [ADR-0015](../../adr/ADR-0015-reporting-sql-plane.md) | `drizzle/0002`, `0004`, `0005`, `src/reporting/`, `src/api/reporting.ts` |
| Intelligence plane | [ADR-0016](../../adr/ADR-0016-intelligence-plane.md) | `drizzle/0003`, `src/intelligence/` |

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
`drizzle/meta/_journal.json` with a strictly increasing `when`.

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
