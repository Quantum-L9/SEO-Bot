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

## The five gates

Run in order. Each one is cheap relative to the one after it, and each answers a
question the next one assumes.

| # | Gate | Command | What it proves |
|---|---|---|---|
| 1 | Static | `npx tsc --noEmit`, `npm run test:gates` | The schema, config and job declarations are internally consistent before anything runs |
| 2 | Deterministic intelligence | `npm run test:intelligence` | Signals, scoring and grouping are reproducible, tenant-scoped, and reachable |
| 3 | Safety policy | `npm run test:gates`, `npm run test:api` | The approval boundary, the rollout ladder and the audience projections hold |
| 4 | Routing | `npm run test:intelligence` | Only allow-listed jobs are queued, once, through BullMQ |
| 5 | Post-run invariants | `npm run verify:intelligence` | The database afterwards contains what the gates above promised |

Gates 1–4 need no services. Gate 5 needs a database and is the one that runs
against staging and production.

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

One type is **still unreachable** and is recorded rather than hidden:
`serp_and_answer_engine_loss` needs `keyword_drop` and a citation signal in one
group, and the extractors key on disjoint dimensions by construction. See
`TODO.md` §3 for the decision it is waiting on.

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

## What is NOT covered here

Stated plainly, because a gap named is a gap someone can close.

- **No live Postgres or Redis integration suite** (contract §7, §8). Every test
  above runs against fakes. The fakes are built to reproduce the properties the
  assertions depend on — at-least-once delivery, `ON CONFLICT DO NOTHING`
  returning nothing, a fresh row getting a fresh id — and one of them did not,
  at first, which is how a test that passed against a broken dedup key was
  caught. That is the standing risk with this approach, and gate 5 against a
  real database is what covers it.
- **No live site-deployment matrix beyond the config layer** (contract §9).
  `tests/services/site-deployment-config.test.ts` covers the dry-run forcing
  rules; nothing exercises a real GitHub or Vercel call, by design.
- **`serp_and_answer_engine_loss` is unreachable** — `TODO.md` §3.

---

## Production-readiness gate (contract §15)

Do not raise the mode past `observe` for a real client until all of these are
true. The command that answers each is beside it.

| | Condition | How |
|---|---|---|
| ☐ | Typecheck clean | `npx tsc --noEmit` |
| ☐ | Full suite green | `npx vitest run` |
| ☐ | Migrations apply to an empty database | `npm run migrate` on a fresh DB |
| ☐ | Migrations apply to a production clone | restore a backup, then `npm run migrate` |
| ☐ | No applied migration was edited | `npm run test:gates` |
| ☐ | `observe` produces correct signals and ZERO actions | `npm run test:intelligence`, then read `intelligence_runs` |
| ☐ | `recommend` produces proposals only | staged cutover test + `action_log` shows only `pending_approval` |
| ☐ | `route_safe` queues only safe jobs | staged cutover test + `job_executions` |
| ☐ | `route_llm` uses the strict JSON planner | `plan-synthesizer.test.ts` |
| ☐ | Unknown actions fail closed | `INTEL-04`, `execution-policy.test.ts` |
| ☐ | Every query filters by clientId | `signal-extractor.test.ts`, `INTEL-10` |
| ☐ | No client B data appears in client A's outputs | `INTEL-10` |
| ☐ | A BullMQ retry does not duplicate an action | `adversarial.test.ts`, `INTEL-03` |
| ☐ | Site deployment stays dry-run in test | `site-deployment-config.test.ts` |
| ☐ | The live-write job stayed disabled | `INTEL-06` |
| ☐ | The LLM spend cap blocks the planner loop | `policy-engine.test.ts`, `INTEL-07` |
| ☐ | The API exposes no credential | `client-projection.test.ts`, `reporting.test.ts` |
| ☐ | Backup and restore rehearsed on staging | `RUNBOOK.md` → Maintenance |

The last one is not a test and cannot be made into one. Rehearse it.
