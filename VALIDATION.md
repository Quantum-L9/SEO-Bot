# VALIDATION.md

## Policy

Validation must be evidence-backed. A script existing is not proof. A clean-looking report is not proof. Every pass, failure, blocked check, and Unknown must map to a file, command, log, URL, receipt, or deterministic inspection.

## Required Local Gate

```bash
npm install
npm run build
npm run verify:all
```

## Validation Classes

| Class | Command | Purpose |
|---|---|---|
| Preflight | `npm run verify:preflight` | env/config readiness |
| Source | `npm run verify:source` | source structure and required files |
| Build | `npm run verify:build` | build output existence and fatal errors |
| Database | `npm run verify:db` | database migration readiness |
| Full | `npm run verify:all` | aggregate gate |

## Evidence Files

Machine-readable validation artifacts live in `validation/`:

- `preflight_checks.jsonl`
- `source_checks.jsonl`
- `build_checks.jsonl`
- `db_checks.jsonl`
- `validation_report.yaml`

## Status Rules

- `PASS`: check executed and met expected result.
- `PASS_WITH_FINDINGS`: core check passed, but warnings or external blockers remain.
- `BLOCKED`: check cannot execute without credentials, URL, or operator values.
- `FAIL`: check executed and violated expected result.
- `UNKNOWN`: insufficient evidence exists.

## Operational Readiness Gate

The SEO Bot is not operationally ready until all are true:

- build passes (`verify:all`)
- docker-compose stack stands up without crashing
- database migrations apply successfully
- first client domain is onboarded via `npm run add-client`
- PostHog connection is verified
- no unsupported claims exist (no fake badges, fake production deployments, or fake contacts)

## Forbidden Validation Patterns

- pass-only reports
- claiming deployment without URL evidence
- hiding Unknowns
- ignoring blocked external checks
- fake badges, contacts, or licenses

## Runtime Safety Gates

## Core Philosophy

1. **Fail-Closed on Configuration:** If an API key is missing, invalid, or a required setting is absent, the Bot must crash immediately on startup rather than failing silently during a job.
2. **Budget Circuit Breakers:** The LLM service must strictly enforce daily token budgets. If the budget is exceeded, strategic jobs must fail-closed (abort) rather than overspending.
3. **Safety Governors:** Autonomous outreach (Link Building) must never exceed defined velocity limits based on domain age.

## Validation Gates

### Gate 1: Environment Configuration (Zod)
- **What it checks:** Presence and format of all variables in `.env`.
- **Enforcement:** `src/core/config.ts` uses Zod `safeParse()`.
- **Failure state:** `process.exit(1)` on startup with a clear list of missing variables.

### Gate 2: Database Migrations
- **What it checks:** The PostgreSQL schema matches the Drizzle ORM definitions.
- **Enforcement:** `scripts/deploy.sh` runs `pnpm migrate` before starting the Bot.
- **Failure state:** Container fails to start; previous database state remains untouched.

### Gate 3: Token Budget Enforcement
- **What it checks:** Daily LLM spend against the `$5.00` hard limit.
- **Enforcement:** `src/services/llm.ts` checks `this.dailySpend >= this.dailyBudgetLimit` before every OpenAI/Claude API call.
- **Failure state:** Throws an error, causing the specific BullMQ job to fail and be logged, but allows the rest of the deterministic Bot to continue running.

### Gate 4: Link Velocity Governor
- **What it checks:** Number of links acquired/outreach sent this week vs. domain age allowance.
- **Enforcement:** `src/modules/link-building/index.ts` checks `LinkVelocityConfig` before queueing new outreach.
- **Failure state:** Prospect remains in `ready` state; outreach is delayed until the next velocity window opens.

### Gate 5: Ranking Drop Circuit Breaker
- **What it checks:** Sudden, catastrophic loss of rankings across the board (>30% drop).
- **Enforcement:** `src/modules/serp-intelligence/index.ts` evaluates the daily rank delta.
- **Failure state:** All active link building and content generation jobs for that client are paused. An emergency alert is sent to the operator via Telegram/Email.

## Testing Requirements for Future Changes

Any PR or modification to this repository MUST pass the following tests before deployment:

1. **Type Checking:** `pnpm tsc --noEmit` must pass with zero errors.
2. **Config Validation:** Adding a new API integration requires a corresponding Zod schema entry in `src/core/config.ts`.
3. **Idempotency Check:** Job handlers in `src/modules/*/index.ts` must be manually reviewed to ensure they can safely run twice if a BullMQ worker crashes mid-execution.

## Health Monitoring

The Bot exposes a continuous health check at `http://localhost:3100/health`.
- Returns `200 OK` with `status: 'healthy'` if the database is connected and the scheduler is active.
- Returns `200 OK` with `status: 'degraded'` if the database connection drops (Docker healthcheck will eventually restart the container).
