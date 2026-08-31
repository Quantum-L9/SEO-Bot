# Intelligence control loop — acceptance and staged rollout

The intelligence module is an autonomous control loop, not just another module,
so it is accepted as one. It may observe, score, recommend, and route safe jobs.
It must not leak tenant data, duplicate work on retries, let the LLM invent
actions, bypass BullMQ, mutate live sites in tests, send outreach unless
explicitly enabled, or execute unknown action types.

Everything below is either a gate that runs in CI today or an operator stage
that needs infrastructure CI does not have. The two are marked separately, and
the second list is not a promise that those stages passed — it is the work
remaining before the loop is turned on.

---

## 1. Modes

`INTELLIGENCE_MODE` is the outer gate. The four capability flags are inner
gates. **Both** must permit a capability, so turning a flag on cannot widen what
the loop may do, and raising the mode cannot switch a capability on by itself.
Reaching a live outreach email requires two deliberate, separately-recorded
operator decisions.

| Mode | Writes runs/signals/opportunities | Writes decisions + action_log | Enqueues safe jobs | Calls the LLM planner | Routes outreach | Routes site mutation |
|---|---|---|---|---|---|---|
| `off` (default) | – | – | – | – | – | – |
| `observe` | yes | – | – | – | – | – |
| `recommend` | yes | yes | – | – | – | – |
| `route_safe` | yes | yes | flag | – | – | – |
| `route_llm` | yes | yes | flag | flag | – | – |
| `full` | yes | yes | flag | flag | flag | flag |

"flag" means the mode permits it and the corresponding variable must also be
`true`:

| Capability | Flag |
|---|---|
| Safe job routing | `INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING` |
| LLM planning | `INTELLIGENCE_LLM_PLANNING_ENABLED` |
| Outreach routing | `INTELLIGENCE_ALLOW_OUTREACH_ROUTING` |
| Site mutation routing | `INTELLIGENCE_ALLOW_SITE_MUTATION` |

Two more:

- `INTELLIGENCE_SIGNAL_TTL_HOURS` (default 72) — signals older than this stop
  scoring into new opportunities.
- `INTELLIGENCE_PORTFOLIO_BENCHMARK` (default off) — the only thing that opens
  the cross-client portfolio route, and it returns anonymized aggregates only.

At `INTELLIGENCE_MODE=off` the job definitions are **not registered at all**.
An unconfigured deployment schedules nothing and writes nothing; the mode is
not merely checked inside handlers.

`intelligence_execute_site_change` is classified **critical** and is therefore
held for human approval in *every* mode, `full` included. There is no
configuration that makes the loop write to a live site by itself.

---

## 2. Gates that run in CI

```bash
npm install --no-audit --no-fund
npx tsc -p tsconfig.check.json --noEmit    # the repo's blocking typecheck
npx vitest run                             # the repo's blocking test gate
npx biome check .
npm run build
```

Targeted:

```bash
npx vitest run tests/modules/intelligence
npx vitest run tests/core/execution-policy.intelligence.test.ts
npx vitest run tests/api/intelligence-routes.test.ts
```

### The suites, and what each is actually for

| Suite | Defends |
|---|---|
| `tests/core/execution-policy.intelligence.test.ts` | Unknown intelligence actions fail closed to `critical`. The hard red test. |
| `tests/modules/intelligence/signal-extractor.test.ts` | Tenant isolation and upsert idempotency, against real SQL. |
| `tests/modules/intelligence/opportunity-scorer.test.ts` | Deterministic, reproducible scoring; stale and suppressed exclusions. |
| `tests/modules/intelligence/policy-gate.test.ts` | The full 6×6 mode/capability matrix plus every runtime governor. |
| `tests/modules/intelligence/evidence-pack-builder.test.ts` | No secrets reach the model; every planner rejection path, including prompt injection. |
| `tests/modules/intelligence/action-router.test.ts` | The closed job allow-list, and one queued job per routing under retry. |
| `tests/modules/intelligence/outcome-attributor.test.ts` | An unmeasurable outcome is `NULL`, never a success. |
| `tests/api/intelligence-routes.test.ts` | Per-client scoping; no `posthogApiKey` or raw `config` in any response. |

### These run against real PostgreSQL

`tests/modules/intelligence/harness.ts` boots **PGlite** — real PostgreSQL,
in-process — and applies the shipped migration files. No Docker, no daemon.

That is deliberate. The properties under test are properties of SQL: whether
`ON CONFLICT (client_id, fingerprint) DO UPDATE` actually collapses a retry onto
one row, whether a `UNIQUE` index actually refuses a second routing claim,
whether `WHERE client_id = $1` actually excludes another tenant. A mocked query
builder answers all three by construction and keeps passing after someone
deletes the `WHERE` clause.

It found a real bug on its first run — see §6.

---

## 3. Staged rollout

Each stage is a deployment configuration plus the observation that must hold
before advancing. Do not skip a stage because the previous one looked fine.

### Stage A — observe

```bash
INTELLIGENCE_MODE=observe
INTELLIGENCE_LLM_PLANNING_ENABLED=false
INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING=false
INTELLIGENCE_ALLOW_OUTREACH_ROUTING=false
INTELLIGENCE_ALLOW_SITE_MUTATION=false
SITE_DEPLOY_DRY_RUN=true
```

Expect: runs, signals, and opportunities created. **Zero** `action_log` rows for
`module='intelligence'`, zero downstream jobs, zero LLM spend, zero site-deploy
calls.

### Stage B — recommend

`INTELLIGENCE_MODE=recommend`

Expect: decisions and `action_log` proposals appear. Still **zero** downstream
jobs — `route_safe_job` is not granted at this mode, so the router records the
proposal and enqueues nothing.

### Stage C — route safe

```bash
INTELLIGENCE_MODE=route_safe
INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING=true
```

Expect only: `serp:competitor-analysis`, `serp:generate-surpass-plan`,
`vitals:check-all-sources`, `aeo:check-citations`, `aeo:optimize-faqs`,
`behavior:generate-insights`.

Never: `links:process-outreach`, `serp:execute-surpass-plans`, any site write.

### Stage D — route LLM

```bash
INTELLIGENCE_MODE=route_llm
INTELLIGENCE_LLM_PLANNING_ENABLED=true
```

Expect: LLM calls originate only from `planActionsWithLlm`, appear in
`llm_usage` under `module='intelligence'`, and invalid planner output is
rejected rather than routed. Confirm the daily cap defers planning by setting
`DAILY_SPEND_CAP` low and watching the planner stand down.

### Stage E — full, dry run

```bash
INTELLIGENCE_MODE=full
INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING=true
INTELLIGENCE_ALLOW_OUTREACH_ROUTING=true
INTELLIGENCE_ALLOW_SITE_MUTATION=true
SITE_DEPLOY_DRY_RUN=true
```

Expect: full planner behaviour; outreach candidates gated by the circuit breaker
and velocity governor; site-mutation candidates routed only to dry-run; **no**
real GitHub or Vercel mutation.

Readiness and liveness are different questions and the gate treats them
differently. A client with no `site_deployment` repo/token is **not ready** and
routing is refused outright. A fully-configured client under
`SITE_DEPLOY_DRY_RUN=true` is **ready but not live**: the work routes and the
transport logs what it would have written. That is exactly what Stage E
rehearses, which is why dry-run must not block routing.

---

## 4. SQL verification pack

Run after every integration or staging run.

```sql
-- Runs must complete or fail with a useful error.
SELECT run_type, mode, status, error, started_at, completed_at
FROM intelligence_runs
ORDER BY started_at DESC
LIMIT 20;

-- No duplicate signals. Must return zero rows.
SELECT client_id, fingerprint, count(*)
FROM intelligence_signals
GROUP BY client_id, fingerprint
HAVING count(*) > 1;

-- No duplicate opportunity routing. Must return zero rows.
SELECT client_id, opportunity_id, job_name, count(*)
FROM intelligence_action_links
WHERE job_name IS NOT NULL
GROUP BY client_id, opportunity_id, job_name
HAVING count(*) > 1;

-- No auto-executed unknown intelligence actions. Must return zero rows.
SELECT *
FROM action_log
WHERE module = 'intelligence'
  AND status = 'auto_executed'
  AND action NOT IN (
    'intelligence_signal_only',
    'intelligence_generate_recommendation',
    'intelligence_run_competitor_analysis',
    'intelligence_generate_surpass_plan',
    'intelligence_optimize_faq_draft',
    'intelligence_queue_outreach',
    'intelligence_request_site_fix',
    'intelligence_execute_site_change'
  );

-- The live-site job must never have been triggered by the loop.
SELECT *
FROM job_executions
WHERE job_name = 'serp:execute-surpass-plans'
ORDER BY started_at DESC
LIMIT 20;

-- Opportunity ranking, per client.
SELECT client_id, opportunity_type, status, score
FROM intelligence_opportunities
ORDER BY score DESC;

-- Signal spread, per client.
SELECT client_id, signal_type, count(*)
FROM intelligence_signals
GROUP BY client_id, signal_type;

-- LLM spend attributable to the loop.
SELECT client_id, module, tier, sum(cost) AS cost
FROM llm_usage
WHERE module = 'intelligence'
GROUP BY client_id, module, tier
ORDER BY cost DESC;

-- Blocked decisions, with the gate that refused. A refusal is evidence:
-- an empty result during a staged rollout means the gates are not being
-- exercised, not that everything is fine.
SELECT mode, source, proposed_action, decision, blocked_reason, count(*)
FROM intelligence_decisions
GROUP BY mode, source, proposed_action, decision, blocked_reason
ORDER BY count(*) DESC;
```

---

## 5. Migrations

Two new migrations, both additive:

- `0002_intelligence_control_loop.sql` — the five loop tables, their foreign
  keys, and the three UNIQUE indexes that carry idempotency.
- `0003_action_outcomes_memory_columns.sql` — repairs pre-existing drift (§6).

Both are hand-authored with `IF NOT EXISTS`, matching the convention
`0001_build_intelligence_artifacts.sql` already established in this repo.

**`npx drizzle-kit generate` does not work here, and did not before this
change.** Its CJS loader cannot resolve the ESM `./schema.js` specifier in
`src/core/database/schema-extensions.ts`:

```
Error: Cannot find module './schema.js'
Require stack:
- src/core/database/schema-extensions.ts
```

That import is on `main`, and `drizzle/meta/` contains only
`0000_snapshot.json` — no snapshot for `0001` — which is why `0001` was
hand-authored too. Fixing the generator is worth doing and is **not** done here:
it touches the schema module's loading for every consumer, which is a change
that deserves its own PR rather than riding along with a feature. Until then,
new migrations are hand-authored, and `drizzle/meta/_journal.json` must be
updated by hand alongside them.

---

## 6. A pre-existing bug this work uncovered

`src/core/database/schema.ts` has declared three columns on `action_outcomes`
since the memory-promotion work landed:

```
memory_record_id        uuid
memory_promoted_at      timestamp
memory_promotion_error  text
```

**No migration ever created them.** Drizzle names every declared column in its
`SELECT` list, so any read of `action_outcomes` against a database built from
these migration files fails:

```
error: column "memory_record_id" does not exist
```

That includes the live `GET /api/token-budget` route, which selects from this
table on every call.

It went unnoticed because no test had ever run a query against a
migration-built database — everything mocked drizzle. The intelligence suite is
the first that does, and it hit this immediately.
`0003_action_outcomes_memory_columns.sql` adds the three nullable columns.

Worth noting for its own sake: a mocked-database test suite cannot find this
class of bug, and this repo has a lot of mocked-database tests.

---

## 7. Production-readiness gate

Verified in this change:

- [x] `npx tsc -p tsconfig.check.json --noEmit` clean
- [x] `npx vitest run` — 758 tests, 56 files, all passing
- [x] `npx biome check` clean on every file touched
- [x] `npm run build` produces `dist/index.js`
- [x] Migrations parse and apply to an empty database (PGlite, real PostgreSQL)
- [x] Unknown intelligence actions fail closed to `critical`
- [x] Every intelligence query filters by `clientId`; no client_b data reaches client_a output
- [x] Retried extraction, scoring, and routing produce no duplicates
- [x] The API exposes no `posthogApiKey` and no raw `clients.config`
- [x] The cross-client portfolio route is 403 by default
- [x] `serp:execute-surpass-plans` is unreachable from the router in every mode
- [x] Site deployment stays dry-run under `NODE_ENV=test`
- [x] The LLM spend cap blocks the planner rather than looping

**Not verified here — these need infrastructure this environment does not have,
and each is a real gate before enabling the loop:**

- [ ] **BullMQ/Redis integration.** No Redis daemon is available in this
      sandbox, so queue behaviour is asserted against a recording fake that
      enforces BullMQ's deduplication rule — as the acceptance brief prescribes
      for unit tests. A live-Redis run of `intelligence:extract-signals`
      (job → `job_executions` row → `intelligence_runs` row → signals) and its
      forced-retry and two-client fan-out variants is still outstanding.
- [ ] **Migration against a production clone.** Applying `0002` and `0003` to a
      restored copy of production, not just an empty database.
- [ ] **Chaos cases.** Postgres unavailable mid-run, Redis unavailable at
      enqueue, statement timeout on a slow query, client deleted mid-run.
- [ ] **Backup and restore rehearsal on staging**, per `RUNBOOK.md`.
- [ ] **Stages A–E on a canary client.** The staged rollout above has been
      specified and its gates unit-tested; it has not been executed against a
      live deployment.

Turning on real outreach or live-site mutation requires the unchecked boxes to
be checked first. Nothing in this change flips a flag: every capability ships
off, and `INTELLIGENCE_MODE` defaults to `off`.
