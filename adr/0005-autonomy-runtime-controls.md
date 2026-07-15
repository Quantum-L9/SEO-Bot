# ADR-0005: Autonomy Runtime Controls

**Status:** Proposed  
**Date:** 2026-07-15  
**Supersedes:** None  
**Related:** ADR-0001 (BullMQ), ADR-0002 (multi-tenancy), ADR-0003 (token budget)

## Context

SEO Bot operates as a 24/7 multi-tenant service on a Hetzner VPS with BullMQ + Redis and Postgres.
Existing job scheduling (BullMQ) and token budgeting (TokenBudget per scheduler job) cover per-run constraints well.

Gaps identified in the L9 nuclear architecture brief:
1. No USD-level cross-run spend tracking or cap enforcement.
2. No registered compensation/rollback path for external SEO API writes or outreach sends.
3. No GitHub Actions workflow for autonomous full-site ops (only `ci.yml` for PR validation exists).
4. No `agent_jobs`, `budget_violations`, or `compensation_log` tables for runtime evidence.

## Decision

Add the following **without replacing or modifying any existing files**:

| New file | Purpose |
|---|---|
| `.github/workflows/autonomy-ops.yml` | Manual/scheduled full-site ops workflow. Does not replace `ci.yml`. |
| `src/core/budget-guard.ts` | `AgentBudgetGuard` class — USD-level admission, reserve, reconcile, enforce. |
| `src/core/compensation.ts` | `CompensationRegistry` — saga rollback for external mutations. |
| `src/core/schema-additions.sql` | Additive DDL for `agent_jobs`, `budget_violations`, `compensation_log`. |

## What does NOT change

- `ci.yml` — untouched.
- `src/core/scheduler.ts` — untouched. Existing `TokenBudget` per-job controls remain primary.
- `src/core/config.ts` — untouched.
- `src/core/database/schema.ts` — the SQL DDL is provided separately; Drizzle migration is a follow-on task.
- `AGENTS.md` locked decisions (BullMQ, multi-tenancy, Pino logging, Drizzle, no Puppeteer/Playwright).
- Existing ADRs 0001–0004.

## Integration path

1. Apply `src/core/schema-additions.sql` to the Postgres database.
2. Add `AgentBudgetGuard` calls to new or high-cost job handlers where USD tracking is needed.
3. Add `CompensationRegistry` registration before external writes in outreach, SEO provider, and future live-site mutation steps.
4. Reflect new tables into `schema.ts` and generate a Drizzle migration (follow-on PR).
5. The `autonomy-ops.yml` workflow fires `node dist/scripts/autonomous-run.js` — this script must be created in a follow-on PR.

## Budget mode thresholds

| Pressure | Mode | Agent action |
|---|---|---|
| < 70% | `normal` | Continue |
| 70–85% | `cheaper_model` | Route to fast tier |
| 85–95% | `narrow_scope` | Reduce page/module scope |
| 95–100% | `require_approval` | Pause and notify |
| > 100% | `stop` | Throw `BudgetExceededError` |

## Consequences

- Every external SEO API write or outreach send that registers a compensation action becomes reversible.
- USD spend is visible per-run and per-client in Postgres for billing, auditing, and anomaly detection.
- The new `autonomy-ops.yml` workflow gives CI/CD entry point for full-site ops without touching the existing `ci.yml`.
