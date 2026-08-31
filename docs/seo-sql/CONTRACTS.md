<!-- L9_META: layer=documentation, role=seo_sql_contract_ledger, status=active, version=1.0.0 -->
# SEO SQL — remaining contracts

Where future work on the SEO SQL planes goes, and what is left to build.

**Branch:** all four contracts below land on `claude/seo-sql-contracts`, stacked on
the branch that shipped the two planes. Do not open a sibling branch off `main`
for this work — it would conflict on the same files (see §Working agreement).

**Shipped already (do not rebuild):**

| Plane | ADR | Code |
|---|---|---|
| Reporting SQL plane | [ADR-0015](../../adr/ADR-0015-reporting-sql-plane.md) | `drizzle/0002_reporting_plane.sql`, `src/reporting/`, `src/api/reporting.ts` |
| Intelligence plane | [ADR-0016](../../adr/ADR-0016-intelligence-plane.md) | `drizzle/0003_intelligence_plane.sql`, `src/intelligence/` |

---

## C1 — Portfolio benchmarking plane

**Gap.** `scripts/reporting/provision-roles.sql` creates `seo_benchmark_reporting`,
but there is nothing benchmark-shaped for it to read: it is granted the same
per-tenant monthly matviews as everyone else. The source brief calls for a
`portfolio_benchmarks` materialized view and an `intel:weekly-portfolio` run type;
neither exists. Cross-client questions ("is a 40% citation rate good for a legal
client in NC?") currently have no answer.

**Build.**
- `reporting.portfolio_benchmarks` — aggregates by industry × geo × period, never
  by client. Median/p25/p75 for position, LCP, exit rate, citation rate.
- A **k-anonymity floor**: suppress any cohort below N clients. Two clients in a
  cohort means each can derive the other's numbers from the aggregate and its own.
  This is the reason the view does not already exist; do not ship it without the
  floor.
- Materialize it, add the UNIQUE index, register it in `MATERIALIZED_VIEWS`.
- Registry entry with an `agent` projection (cohort stats carry no identity).
- `intelligence_runs.run_type = 'weekly_portfolio_benchmark'`.

**Done when.** A benchmark query returns cohort statistics, a cohort under the
floor returns no row rather than a small-n row, and `plane-contract.test.ts`
still passes (it checks the registry against the migration).

**Touches.** `drizzle/0004_*`, `src/reporting/views.ts`, `src/reporting/refresh.ts`,
`src/intelligence/runner.ts`, ADR-0015 open question #1.

---

## C2 — Evidence-pack consumer

**Gap.** `buildEvidencePack` produces a redacted pack with `allowed_actions` and
`forbidden_actions`, asserts it leaks nothing, and stores it on the decision row —
and **nothing reads it.** `getLlmService` is never imported in `src/intelligence/`.
The action planner picks a remedy from a static per-type template, so the plane
currently reasons deterministically end to end and the packs are inert.

That is a deliberate ordering, not an oversight: the deterministic path had to be
correct and testable before a model was allowed to influence it. C2 is where
judgment enters.

**Build.**
- A service that takes a stored pack and returns a *ranked selection from
  `allowed_actions`* plus a rationale — never free-form action text. Reject any
  response naming an action outside the pack's own allow-list.
- Route it through `src/services/llm.ts` (the `@quantum-l9/llm-router` owner).
  Do not add a second LLM client.
- The plane's job budgets are currently zero (asserted by
  `registration.test.ts`). A token-spending step needs its own budgeted job, and
  the policy engine's `requiresLlm` path already exists to gate it.
- Fall back to the static template when the model is unavailable or its answer
  fails validation. Availability of a model must not become a dependency of the
  bot reasoning at all.

**Done when.** A pack produces a validated action selection, an out-of-allow-list
response is rejected in a test, and the plane still functions with the LLM
disabled.

**Touches.** `src/intelligence/action-planner.ts`, new
`src/intelligence/plan-synthesizer.ts`, `src/intelligence/index.ts`,
`src/core/scheduler.ts` (a budgeted job), ADR-0016.

---

## C3 — Opportunity lifecycle and approved-action attribution

**Gap — two halves, both live defects rather than missing features.**

1. `intelligence_opportunities.status` has no transition. Nothing sets it to
   `actioned`, `resolved`, or `expired`; every row is `open` forever. The
   duplicate-suppression lookup in `runner.ts` is bounded by the signal cooldown
   *specifically to stop that becoming permanent suppression* — read the comment
   on `loadOpenOpportunityFingerprints` before changing it. That bound is a
   holding measure; the lifecycle is the real fix.
2. An operator-approved CRITICAL action goes nowhere. `approveAction()` sets
   `status = 'approved'` and no code reads it: no `action_outcomes` row, no
   experiment window, no follow-up job. Only auto-executed actions are measured,
   so the highest-risk changes are the least measured — exactly backwards.

**Build.**
- Status transitions: `open` → `actioned` when a proposal is logged, → `resolved`
  when a linked experiment measures `improved`, → `expired` after a configurable
  age with no signal recurrence.
- An approved-action sweep that does for approved actions what
  `onExecutedProposal` does for auto-executed ones.
- Once transitions exist, revisit whether the cooldown bound on the duplicate
  lookup is still needed or can key off status instead.

**Done when.** An opportunity reaches a terminal status, an approved CRITICAL
action opens a measurement window, and the RUNBOOK's `status = 'open'` query
stops needing its caveat.

**Touches.** `src/intelligence/runner.ts`, `src/core/execution-policy.ts`, new
`src/intelligence/lifecycle.ts`, `RUNBOOK.md`, ADR-0016 open question #3.

---

## C4 — Operator dashboard surface

**Gap.** `src/api/dashboard.ts` contains zero references to either plane. The
operator's daily job is reviewing what the bot concluded, and today that means
writing SQL by hand against `intelligence_decisions` — the exact manual work the
planes were built to remove.

**Build.**
- Panels for open opportunities by score, recent decisions with their rationale,
  experiments awaiting measurement, and measured outcomes.
- Materialized-snapshot age surfaced inline. An operator reading a stale number
  without knowing it is stale is worse served than one shown no number.
- Reuse the reporting gateway rather than querying tables directly — that is what
  the audience projections and audit log are for.
- `dashboard.ts` escapes hostile DB values at every render site
  (`tests/api/dashboard.test.ts` pins this). New panels must do the same;
  `learnings` and `rationale` are model-authored free text.

**Done when.** An operator can answer "what did the bot do this week and did it
work?" without opening psql.

**Touches.** `src/api/dashboard.ts`, `tests/api/dashboard.test.ts`.

---

## Working agreement

**Order.** C3 first — it repairs live defects. Then C1 (self-contained, no
dependencies). Then C2 (wants C3's lifecycle to measure whether model-chosen
actions beat template-chosen ones). C4 last, once there is a lifecycle worth
displaying.

**Stack, do not fan out.** C1–C4 all touch `src/intelligence/` and
`src/reporting/`. Parallel sibling branches off `main` will conflict. Work them
sequentially on `claude/seo-sql-contracts`, or stack a child branch per contract
on the previous one's head (`PR_STACK=auto` does this; bottom-up merge order).

**Boundaries that do not move.** These are not C1–C4's to renegotiate:
- The intelligence plane proposes; it never writes to a client site.
- `serp:execute-surpass-plans` stays off `TRIGGERABLE_JOBS` (AGENTS §9).
- The execution policy's auto-execute band and CRITICAL classification are
  unchanged without operator sign-off.
- Agent-audience projections never gain client identity or contact PII.
- No migration creates a role or embeds a password.

**Gate.** `npx tsc --noEmit && npx vitest run`, both green with output shown.
Add a migration with `npx drizzle-kit generate` or by hand following
`0002`/`0003`; never edit an applied migration; register it in
`drizzle/meta/_journal.json` with a strictly increasing `when`.

**Publish.** `python3 ops/autonomy/l4_local.py begin --contract-id "<id>"` →
`authorize-release` → `PR_REMEDIATE=0 make pr`. Do not raw-push.
