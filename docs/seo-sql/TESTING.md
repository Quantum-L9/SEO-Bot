<!-- L9_META: layer=documentation, role=seo_sql_testing_contract, status=active, version=1.0.0 -->
# SEO SQL — testing contract (C6)

How the intelligence and reporting planes are tested, what each gate is for, and
the checklist that has to be true before the plane is turned on for a real
client.

The premise of the contract this implements: **test it as a new autonomous
control loop, not as a new module.** The plane may observe, score, recommend and
route safe jobs. It must not leak tenant data, duplicate work on retries, let a
model invent actions, bypass BullMQ, mutate live sites in tests, send outreach
unless explicitly enabled, or execute an unknown action type.

---

## The six gates

Run in order. Each one is cheap relative to the one after it, and each answers a
question the next one assumes.

| # | Gate | Command | What it proves |
|---|---|---|---|
| 1 | Static | `npx tsc --noEmit`, `npm run test:gates` | The schema, config and job declarations are internally consistent before anything runs |
| 2 | Deterministic intelligence | `npm run test:intelligence` | Signals, scoring and grouping are reproducible, tenant-scoped, and reachable |
| 3 | Safety policy | `npm run test:gates`, `npm run test:api` | The approval boundary, the rollout ladder and the audience projections hold |
| 4 | Routing | `npm run test:intelligence` | Only allow-listed jobs are queued, once, through BullMQ |
| 5 | Live services | `npm run test:live` | The fakes above told the truth: real Postgres semantics, real BullMQ dedup, real extractor SQL |
| 6 | Post-run invariants | `npm run verify:intelligence` | The database afterwards contains what the gates above promised |

Gates 1–4 need no services. Gate 5 needs a real Postgres and Redis. It has two
halves: `npm run test:live`, which runs against disposable services in CI and
locally, and `npm run verify:intelligence`, which is read-only and is the half
that runs against staging and production.

---

## Static gates (contract §2)

`tests/migrations/static-gates.test.ts`. Four conditions that must fail a run
before any runtime test is worth doing:

- **An applied migration is immutable.** drizzle's journal records *that* a tag
  ran, never what it said — so editing an applied migration is invisible to
  every tool in the repo, and the deployed database keeps text the file no
  longer contains. `drizzle/CHECKSUMS.json` is the missing half. Adding a
  migration adds a line; changing one changes a line, which is the reviewable
  diff that says an applied migration was rewritten.
- **Migrations are additive.** A destructive statement needs
  `-- l9:non-additive: <reason>` above it. Declared, not banned: a rule with no
  escape hatch gets deleted rather than used.
- **Every env var is declared.** Anything read from `process.env` outside
  `config.ts` is either in the schema or in a named exemption list with its
  reason. Everything the schema declares is documented in `.env.example` — a
  dial the operator cannot find is a dial that does not exist.
- **`ModuleName` carries the plane.** Without the member, every row the plane
  writes is attributed elsewhere and the verification pack's
  `WHERE module = 'intelligence'` returns nothing while the plane runs unaudited.

The fifth static condition — intelligence jobs declaring a token budget — is
enforced against the live scheduler definitions in
`tests/intelligence/registration.test.ts`, which is stronger than a file scan.
It is deliberately not duplicated.

---

## Modes before behavior (contract §1, §11)

`tests/intelligence/staged-cutover.test.ts` asserts the **whole side-effect
ledger** at each rung — every table written, every job queued, every
`action_log` status — from one seed carrying both a safe-remedy and an
outreach-remedy opportunity.

| Mode | Writes runs/signals/opportunities | Writes decisions + action_log | Queues jobs | Reaches a model |
|---|---|---|---|---|
| `off` | no | no | no | no |
| `observe` | yes | no | no | no |
| `recommend` | yes | yes (all `pending_approval`) | no | no |
| `route_safe` | yes | yes (mixed) | non-outreach only | no |
| `route_llm` | yes | yes | non-outreach only | ranking only |
| `full` | yes | yes | + outreach **only with its flag** | ranking only |

No rung reaches the live-site write job, with both out-of-ladder flags set. It
is excluded from `TRIGGERABLE_JOBS` and named by no plan template — two locks,
neither of which is a rollout flag.

`mode.test.ts` covers the same ladder at the predicate level; the two are
complementary. Predicates prove monotonicity across every mode automatically;
the ledger proves what the runner actually did, which is what an operator
raising a rung is promised.

---

## Reachability (contract §3)

`tests/intelligence/calibration.test.ts` drives every actionable opportunity
type from an extreme-but-real view row, through the real `mapRow`, through the
real scorer, against the real default threshold.

This exists because the scorer's own calibration test builds signals by hand: it
proves the scorer *can* reach the threshold given a high-severity signal, not
that any extractor can produce one. `link_outreach_batch` fell through that gap
— its extractor capped severity at `medium`, worth 18 against a threshold of
20, so outreach could never be proposed while the outreach flag, the velocity
governor and `route_safe`'s promise all guarded it. Every one of those controls
tested green, because each tested its own logic rather than whether the road it
blocked went anywhere.

`serp_and_answer_engine_loss` was the second type this file caught, and it is
now reachable. It needs `keyword_drop` and a citation signal in one group, and
every citation signal keyed on `platform:<name>` while `keyword_drop` keyed on a
page or `keyword:<kw>` — dimensions that cannot meet. It was recorded as waiting
on a product decision about new data, which was wrong: `aeo_citations` has
always carried a per-row `query`, and only the per-platform rollup discarded it.
`competitorCitationExtractor` now emits a keyword-scoped signal alongside its
platform-scoped one, for queries that match a tracked keyword's ranking drop,
keyed exactly as `keywordDropExtractor` keys. The platform scope is byte-
identical to before, so `answer_engine_gap` keeps its per-platform targeting.

The tests assert the **mechanism** — that the two group keys are equal, that the
two scopes get distinct fingerprints, and that the keyword scope respects the
same 5-position bar — not a score, which a weights tweak could mask. Reversing
any one of the three makes them fail.

Worth knowing when reading a portfolio: the compound scores **27.43** where the
single-symptom `keyword_recovery` on the same drop scores **30.60**. That is the
ROI formula working as written (dividing by `effort + risk`, which is 7 for the
compound and 5 for the recovery), not a defect — a harder remedy for a worse
problem can rank below a cheap one. It clears the threshold either way, so the
plane acts on it; it just does not automatically sort to the top.

---

## Hostile input (contract §5)

`tests/intelligence/adversarial.test.ts`. Competitor titles and answer-engine
snippets are attacker-controlled: anyone who can rank for a client's keyword can
put a sentence in the evidence pack.

The hostile text is deliberately **not** stripped — redacting it would hide from
the ranking step what a competitor is doing. What is asserted is that arriving
buys it no authority: it sits quoted under `evidence`, the pack carries no
system/instruction/tool field a model could read as a command, both the allowed
and forbidden lists are stated explicitly, and a model that obeys the injection
is rejected **whole** rather than per-entry. Keeping the valid entries would
teach an attacker to append one bad suggestion to a list of good ones and lose
nothing.

---

## Failure and retry (contract §12)

Same file. Organized around what the operator finds in the database afterwards,
because a failure that leaves a half-written record is worse than one that
throws — the throw is visible, the half-record looks like a result.

| Condition | Required behavior |
|---|---|
| Postgres unreachable mid-run | Run marked `failed`, rethrown, nothing queued |
| Queue unreachable after the decision | Fails visibly; the open window self-corrects via an `unchanged` verdict, which REOPENS the opportunity |
| Retried run | Suppressed — the previous run left the opportunity `actioned` |
| Two concurrent runs | Identical BullMQ key, derived from the opportunity fingerprint, so the queue collapses them |
| Client goes inactive | Diagnosed and recorded; nothing proposed |
| Client disappears | Run marked `failed` |
| A view row claiming another tenant | Impossible to write — tenancy comes from the run, never from the row |

---

## Post-run invariants (contract §13)

`scripts/intelligence/verify-invariants.ts`, 14 checks, each phrased so that
**rows mean a violation**. No expected count, no threshold to argue with.

```bash
npm run verify:intelligence          # exit 0 clean · 1 violation · 2 could not run
npx tsx scripts/intelligence/verify-invariants.ts --json
npx tsx scripts/intelligence/verify-invariants.ts --only=INTEL-04
```

A query that ERRORS is a finding, never a pass — a check against a relation that
does not exist must never read as "nothing wrong". Read-only twice over:
keyword-checked before sending, and the session sets
`default_transaction_read_only`.

`tests/scripts/verify-invariants.test.ts` validates the pack against the
migrations at this commit, so a query naming a relation or column that does not
exist fails in CI rather than during an incident.

---

## Live services (gate 5)

`tests/live/*.live.test.ts`, run by `npm run test:live` against a real Postgres
and a real Redis. Excluded from the default `vitest run` on purpose: a default
run that silently skipped them would report green for a gate it never reached.

```bash
npm run live:up          # docker compose -f docker-compose.validation.yml, --wait
export DATABASE_URL=postgres://l9bot:validation-only@127.0.0.1:55432/l9_seo_bot_validation
export REDIS_URL=redis://127.0.0.1:56379
npm run migrate          # first run only, or after adding a migration
npm run test:live
npm run live:down        # -v, so the next run starts from an empty database
```

The compose file binds both to loopback on non-default host ports, so starting
them does not shadow a real Postgres on 5432 or Redis on 6379. Any other
reachable pair works too — the suite reads `DATABASE_URL` and `REDIS_URL` and
knows nothing about compose.

Without services the suite skips and says how to start them.
`LIVE_SERVICES_REQUIRED=1` turns that skip into a failure; the `gate5` job in
`.github/workflows/ci.yml` sets it, so the gate cannot pass by finding nothing
to do. CI uses Actions `services:` rather than the compose file — same images,
no port mapping to keep in sync.

### Why it exists

Everything else in `tests/` runs against fakes, and this repo has now been
wrong twice about what those fakes were imitating:

- A mock reused row ids, so a **dedup key that deduplicated nothing** passed its
  test. Caught by hand while writing that test, and fixed by correcting the
  mock — which proves the mock.
- Every queue in the suite is a `vi.fn()` that accepts any job id. Three call
  sites built ids by interpolating `:` separators, and **BullMQ rejects a custom
  id containing `:`**. So `queue.add()` threw at all three, every dedup
  protection they were written for had never once run, and every test around
  them was green. Found by this suite's first execution.

The pattern is the same one the reachability gate exists for: a control whose
own logic is correct, guarding a path that goes nowhere.

### What it asserts

| File | What only a real service can answer |
|---|---|
| `migrations.live.test.ts` | The migration set applies to an empty database; the relations and the `(run_id, fingerprint)` unique index exist; `aeo_citations.query` — the column the compound diagnosis joins on — is still there |
| `postgres-semantics.live.test.ts` | `ON CONFLICT DO NOTHING` really returns nothing; a fresh row really gets a fresh id; the unique index rejects a duplicate even without the clause; the same fingerprint is allowed on a *different* run; a tenant filter filters with a second tenant present |
| `extractors.live.test.ts` | Every extractor's SQL executes against the migrated schema — a query naming a dropped column passes every `mapRow` test and fails first in production, inside a `try` that logs and continues with one extractor silently dead. Also drives `serp_and_answer_engine_loss` end to end, from rows through the real SQL into a scored opportunity |
| `queue.live.test.ts` | BullMQ collapses two adds sharing a `jobId`; distinct opportunities stay distinct; and `isBullMqSafeJobId` accepts exactly what real BullMQ accepts — the one place the rule meets the implementation rather than another fake |

Seeding is per-test and teardown is by client id, never a truncate: gate 5 is
defined as the gate that may point at staging, and a truncate there is not a
test failure, it is an outage.

---

## What is NOT covered here

Stated plainly, because a gap named is a gap someone can close.

- **No fake is now unchecked, but the fakes are still what most tests use.**
  Gate 5 pins the properties they claim (see below); it does not re-run the
  whole suite against real services, and it is not meant to. A property the
  live suite does not name is still a property only a fake vouches for.
- **No live site-deployment matrix beyond the config layer** (contract §9).
  `tests/services/site-deployment-config.test.ts` covers the dry-run forcing
  rules; nothing exercises a real GitHub or Vercel call, by design.
- **No live answer-engine or SERP vendor call.** Every vendor response in the
  suite is a fixture, including the `aeo_citations` rows the keyword-scoped
  citation signal joins on.

---

## Production-readiness gate (contract §15)

Do not raise the mode past `observe` for a real client until all of these are
true. The command that answers each is beside it.

| | Condition | How |
|---|---|---|
| ☐ | Typecheck clean | `npx tsc --noEmit` |
| ☐ | Full suite green | `npx vitest run` |
| ☐ | Migrations apply to an empty database | `npm run test:live` (gate 5 asserts it) |
| ☐ | Migrations apply to a production clone | restore a backup, then `npm run migrate` |
| ☐ | No applied migration was edited | `npm run test:gates` |
| ☐ | `observe` produces correct signals and ZERO actions | `npm run test:intelligence`, then read `intelligence_runs` |
| ☐ | `recommend` produces proposals only | staged cutover test + `action_log` shows only `pending_approval` |
| ☐ | `route_safe` queues only safe jobs | staged cutover test + `job_executions` |
| ☐ | `route_llm` uses the strict JSON planner | `plan-synthesizer.test.ts` |
| ☐ | Unknown actions fail closed | `INTEL-04`, `execution-policy.test.ts` |
| ☐ | Every query filters by clientId | `signal-extractor.test.ts`, `INTEL-10` |
| ☐ | No client B data appears in client A's outputs | `INTEL-10` |
| ☐ | A BullMQ retry does not duplicate an action | `adversarial.test.ts`, `INTEL-03`, and `queue.live.test.ts` against real Redis |
| ☐ | Site deployment stays dry-run in test | `site-deployment-config.test.ts` |
| ☐ | The live-write job stayed disabled | `INTEL-06` |
| ☐ | The LLM spend cap blocks the planner loop | `policy-engine.test.ts`, `INTEL-07` |
| ☐ | The API exposes no credential | `client-projection.test.ts`, `reporting.test.ts` |
| ☐ | Backup and restore rehearsed on staging | `RUNBOOK.md` → Maintenance |

The last one is not a test and cannot be made into one. Rehearse it.
