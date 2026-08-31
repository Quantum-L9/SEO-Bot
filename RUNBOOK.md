# Operator Runbook

This document explains how to operate, maintain, and troubleshoot the L9 SEO Bot in production.

Developer / agent tooling (Biome CI + Cursor plugin) is not an ops procedure.
See `docs/runbooks/BIOME_INSTANTIATION.md`.

## Daily Operations

The Bot is designed to be fully autonomous. Daily operations primarily consist of reviewing the weekly Friday report and approving/rejecting queued actions.

### 1. Adding a New Client

When a new Astro site is deployed, onboard it to the SEO Bot:

```bash
# SSH into the Hetzner VPS
ssh root@your-vps-ip
cd l9-seo-bot

# Run the interactive onboarding script
docker compose exec l9-seo-bot pnpm add-client
```

You will be prompted for the domain, PostHog project ID, target keywords, and industry. The Bot will automatically begin monitoring the site on its next scheduled cron cycle.

### 2. Client Site Integration

For the Bot to collect Behavior Intelligence and Web Vitals, you MUST add the tracking snippet to the client's Astro site.

1. Open `client-snippets/posthog-tracking.html`.
2. Replace `__POSTHOG_HOST__` with your VPS IP or domain (e.g., `https://analytics.youragency.com`).
3. Replace `__POSTHOG_PROJECT_KEY__` with the specific client's PostHog API key.
4. Paste the snippet into the `<head>` of the Astro site's `BaseLayout.astro`.

### 3. Viewing the Dashboard

You can view the health and status of all clients via the API:

```bash
# Check system health
curl http://localhost:3100/health

# List all active clients
curl http://localhost:3100/api/clients

# Get detailed weekly report for a specific client
curl http://localhost:3100/api/clients/<client-id>/report
```

*(A full frontend UI is planned for a future release. For now, the JSON API provides all necessary data.)*

## Manual Overrides

If you need to force the Bot to run a specific module out-of-schedule (e.g., you just launched a major site update and want to check vitals immediately):

```bash
curl -X POST http://localhost:3100/api/clients/<client-id>/trigger \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"module": "vitals:check-all-sources"}'
```

Valid modules (the `TRIGGERABLE_JOBS` allow-list in `src/core/scheduler.ts`, shared with the intelligence plane's action planner): `serp:check-rankings`, `serp:competitor-analysis`, `serp:generate-surpass-plan`, `vitals:check-all-sources`, `aeo:check-citations`, `aeo:optimize-faqs`, `links:discover-prospects`, `links:process-outreach`, `behavior:pull-engagement`, `behavior:generate-insights`.

`serp:execute-surpass-plans` is deliberately absent: it writes the client's live site and is gated (AGENTS §9).

## Reporting SQL Plane

Cross-client and cross-module questions go through the named-query gateway, not a database connection.

```bash
# What can I ask?
curl -s http://localhost:3100/api/reporting/views \
  -H "Authorization: Bearer $OPERATOR_API_KEY" | jq '.views[].name'

# Which keywords lost ground this week, worst first?
curl -s -X POST http://localhost:3100/api/reporting/query \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"view":"keyword_drops_7d","filters":{"min_delta":10},"limit":25}' | jq

# Which pages are both slow and losing visitors?
curl -s -X POST http://localhost:3100/api/reporting/query \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"view":"page_experience_risks","filters":{"risk_level":["critical","high"]}}' | jq

# What is waiting on my approval?
curl -s -X POST http://localhost:3100/api/reporting/query \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"view":"pending_approvals"}' | jq
```

`truncated: true` in the response means the page was exactly full — raise `limit` (up to the view's `maxLimit`) rather than assuming you saw everything.

### First-time setup (once, after migration 0002 applies)

Direct `psql` access for an operator is provisioned separately from the application role. The migration creates no roles and embeds no passwords.

```bash
psql "$SUPERUSER_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v db_name="$(psql "$DATABASE_URL" -Atc 'select current_database()')" \
  -v human_password="$(openssl rand -base64 24)" \
  -v agent_password="$(openssl rand -base64 24)" \
  -v benchmark_password="$(openssl rand -base64 24)" \
  -f scripts/reporting/provision-roles.sql
```

Store the generated passwords in the secrets plane. The script prints a grant summary at the end: **`public_grants` must be 0 for every role** — a non-zero value means a reporting role can reach `public.clients`, which holds `posthog_api_key`.

### Stale reporting numbers

The portfolio views (monthly spend, monthly citation rate, weekly keyword movements) are materialized and refreshed every 6 hours.

```bash
curl -s http://localhost:3100/api/reporting/refresh-status \
  -H "Authorization: Bearer $OPERATOR_API_KEY" | jq
```

A high `ageSeconds` or `status: "error"` means that snapshot is stale. The refresh job throws on failure, so it also appears in `job_executions` and the bot's own `job_failure_cluster` signal.

## Intelligence Plane

The bot runs its own daily triage per client at 07:30 — after the overnight collection jobs — and records what it concluded. Nothing here writes to a client site; proposals go through the same execution policy and approval queue as everything else.

```sql
-- What did the bot conclude, and why?
SELECT d.created_at, d.decision_type, d.decision, d.rationale, d.requires_approval
FROM intelligence_decisions d
WHERE d.client_id = '<client-id>'
ORDER BY d.created_at DESC
LIMIT 20;

> Most of what follows is now on **`/dashboard/intelligence`** (contract C4) —
> open work by score, the last seven days of decisions with their rationale,
> windows still counting down, and measured outcomes with snapshot age inline.
> Reach for psql when you need a shape the page does not have.

-- What is it currently prioritizing?
-- `status` transitions now (contract C3): open → actioned when a proposal is
-- logged, → resolved when a linked experiment measures `improved`, → expired
-- when it ages out without recurring. A refuted or flat remedy sends an
-- opportunity back to `open`, so this really is live work rather than history.
SELECT opportunity_type, title, score, status, target_url, target_keyword, created_at
FROM intelligence_opportunities
WHERE client_id = '<client-id>'
  AND status IN ('open', 'actioned')
ORDER BY score DESC;

-- What did the bot conclude actually worked, and what did it have to reopen?
SELECT status, count(*)
FROM intelligence_opportunities
WHERE client_id = '<client-id>'
GROUP BY status;

-- Approved CRITICAL actions still waiting for the lifecycle sweep to pick them
-- up. A row here for more than an hour means intel:lifecycle-sweep is not running.
SELECT id, action, risk_level, approved_at
FROM action_log
WHERE client_id = '<client-id>'
  AND status = 'approved'
  AND executed_at IS NULL
ORDER BY approved_at;

-- Did the changes actually work?
SELECT target_metric, entity_id, status, result
FROM intelligence_experiments
WHERE client_id = '<client-id>' AND status IN ('measured', 'inconclusive')
ORDER BY created_at DESC;
```

### Pausing a client's autonomous actions

The pause switch is operator-owned and survives every policy refresh:

```sql
INSERT INTO intelligence_policy_state (client_id, autonomous_actions_paused, pause_reason)
VALUES ('<client-id>', true, 'site migration in progress')
ON CONFLICT (client_id) DO UPDATE
  SET autonomous_actions_paused = true,
      pause_reason = EXCLUDED.pause_reason,
      updated_at = now();
```

While paused, the bot keeps observing and measuring, and keeps surfacing repeated job failures and budget pressure — those are never silenced, because they are the conditions under which the rest of its data stops being trustworthy. Set `autonomous_actions_paused = false` to resume.

To stop the plane spending tokens entirely, unset `INTELLIGENCE_LLM_PLANNING_ENABLED`. Every other job is deterministic, so the bot keeps observing, deciding, and measuring; proposals simply keep the action their static template chose.

To slow the plane globally instead, lower `INTELLIGENCE_MAX_ACTIONS_PER_RUN` (0 stops proposals entirely, leaving observation and measurement running) or raise `INTELLIGENCE_MIN_OPPORTUNITY_SCORE`.

### The approval queue is filling up

Fingerprint suppression (`INTELLIGENCE_SIGNAL_COOLDOWN_DAYS`, default 7) should stop an unchanged problem regenerating every cycle. If the queue is still growing:

1. `SELECT signal_type, count(*) FROM intelligence_signals WHERE client_id = '<id>' AND observed_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;` — one extractor firing constantly usually means a genuine unfixed problem, not a bug.
2. Raise `INTELLIGENCE_MIN_OPPORTUNITY_SCORE` to be more selective.
3. Lower `INTELLIGENCE_MAX_ACTIONS_PER_RUN` to bound the per-run volume.

## Intelligence Plane — Staged Cutover

Installing the plane and enabling it are two decisions. `INTELLIGENCE_MODE` is
the second one: a ladder where each rung is a superset of the one before, raised
one step at a time and lowered in one step.

**Rollback at any point is one environment variable plus a restart.** No code
change, no migration, no data loss:

```bash
# In .env
INTELLIGENCE_MODE=off
./scripts/deploy.sh restart
```

### The ladder

| Mode | The plane may | It may not |
|---|---|---|
| `off` | nothing — installed and inert | anything |
| `observe` | record signals and opportunities | propose, queue, or spend |
| `recommend` | write proposals and decisions | queue any job |
| `route_safe` | queue non-outreach follow-up jobs; open measurement windows | reach a model; send outreach |
| `route_llm` | rank remedies a pack already permits | author an action; send outreach |
| `full` | everything on the ladder | **still not** outreach or site mutation |

Two capabilities are **outside** the ladder, each behind its own flag, because
both are irreversible and neither should follow from a mode name:

| Flag | Grants | Also requires |
|---|---|---|
| `INTELLIGENCE_ALLOW_OUTREACH_ROUTING` | queueing `links:process-outreach` | `route_safe` or above |
| `INTELLIGENCE_ALLOW_SITE_MUTATION` | queueing live-site writes | `route_safe` or above, plus the job being on `TRIGGERABLE_JOBS` — it is not |

`INTELLIGENCE_LLM_PLANNING_ENABLED` remains decisive at every mode: unset or
`false` stops all token spend, and raising the mode never re-enables it.

### Network exposure

Postgres, Redis and ClickHouse bind to `127.0.0.1` and are **not** reachable
from outside the host. Containers talk to each other over the `l9-network`
bridge and do not use the published ports, so nothing internal depends on this.

Two consequences worth knowing before you need them:

- **Remote `psql` needs a tunnel.** `ssh -L 5432:127.0.0.1:5432 <host>`, then
  connect to `localhost:5432` as usual. The same pattern works for Redis (6379)
  and ClickHouse (8123).
- **Restoring a backup from your laptop** goes through that tunnel too, or run
  the restore on the host.

Ports `3100` (bot API and dashboard) and `8000` (PostHog) stay published: they
are the operator-facing surfaces, they authenticate, and they belong behind your
reverse proxy. `OPERATOR_API_KEY` and `DASHBOARD_ALLOWED_ORIGINS` are what guard
them — loopback-binding them instead would take the product down rather than
harden it.

### Deploying the substrate (mode stays off)

The update path backs up, migrates, and only then starts the new bot, so a
failed migration aborts with the old container still serving:

```bash
./scripts/deploy.sh update
curl -s http://localhost:3100/health
```

Verify the plane is installed and inert before raising the mode:

```sql
-- The tables exist and are empty. Nothing has run.
SELECT count(*) FROM intelligence_runs;
```

### Phase 1 — observe

```bash
# .env
INTELLIGENCE_MODE=observe
INTELLIGENCE_LLM_PLANNING_ENABLED=false
INTELLIGENCE_ALLOW_OUTREACH_ROUTING=false
INTELLIGENCE_ALLOW_SITE_MUTATION=false
SITE_DEPLOY_DRY_RUN=true
```

Restart, then let the 07:30 triage run once per client. The plane's jobs are
scheduled, not manually triggerable — `intel:*` is deliberately absent from
`TRIGGERABLE_JOBS`, because that list is shared with the action planner and a
triage job on it could target itself.

What you should see after the first pass:

```sql
-- Runs completed, zero tokens spent.
SELECT run_type, status, llm_used, started_at, completed_at
FROM intelligence_runs ORDER BY started_at DESC LIMIT 10;

-- Signals and opportunities recorded.
SELECT signal_type, severity, count(*) FROM intelligence_signals
WHERE client_id = '<client-id>' GROUP BY 1, 2;

SELECT opportunity_type, status, score, title FROM intelligence_opportunities
WHERE client_id = '<client-id>' ORDER BY score DESC LIMIT 10;
```

And what must be **empty** — this is the check that proves the gate holds:

```sql
-- No proposals, no decisions, no measurement windows, nothing executed.
SELECT count(*) FROM intelligence_decisions WHERE client_id = '<client-id>';
SELECT count(*) FROM action_log
WHERE client_id = '<client-id>' AND triggered_by LIKE 'intelligence:%';
```

Both must be `0`. If either is non-zero in `observe`, stop and investigate
before raising the mode — the gate is the thing being tested at this stage, not
the bot's judgment.

Read what the bot concluded at `/dashboard/intelligence`. Stay here until the
opportunities it surfaces look like problems you agree are problems.

### Phase 2 — recommend

```bash
INTELLIGENCE_MODE=recommend
```

Proposals and decisions now appear; nothing is queued. Every withheld action is
recorded as awaiting approval, never as executed, so `action_log` distinguishes
"the bot chose not to" from "the rollout gate withheld it":

```sql
SELECT module, action, status, risk_level, created_at FROM action_log
WHERE client_id = '<client-id>' AND triggered_by LIKE 'intelligence:%'
ORDER BY created_at DESC LIMIT 10;
```

No row should read `auto_executed`. `action_log` records the decision's outcome
but not its reasoning, so the "why" is on the decision row, prefixed
`Withheld by rollout gate:`:

```sql
SELECT d.created_at,
       d.decision_type,
       d.policy_basis -> 'execution_policy' ->> 'reason' AS execution_reason
FROM intelligence_decisions d
WHERE d.client_id = '<client-id>'
ORDER BY d.created_at DESC
LIMIT 10;
```

### Phase 3 — route safe jobs

```bash
INTELLIGENCE_MODE=route_safe
```

Auto-executed proposals now open measurement windows and queue their follow-up
jobs. `links:process-outreach` is still blocked, and blocked visibly — a log
line naming the job and the flag, not a silent skip.

Wait for at least one full measurement window (`INTELLIGENCE_MEASUREMENT_DAYS`,
default 28) before going further. The point of this phase is to find out whether
the bot's remedies actually work, and that answer does not exist sooner:

```sql
-- The verdict lives in `result`, not in a column of its own; `status` moves off
-- 'measuring' once a window has been judged.
SELECT e.target_metric,
       e.status,
       e.result ->> 'verdict'   AS verdict,
       e.result ->> 'learnings' AS learnings,
       e.measurement_end
FROM intelligence_experiments e
WHERE e.client_id = '<client-id>'
  AND e.status <> 'measuring'
ORDER BY e.measurement_end DESC;
```

### Phase 4 — LLM planning

```bash
INTELLIGENCE_MODE=route_llm
INTELLIGENCE_LLM_PLANNING_ENABLED=true
```

The model ranks remedies the evidence pack already permits; it cannot author an
action. Watch spend against the job's budget for a week before proceeding.

### Phase 5 — limited autonomy

Only after Phase 3 has produced measured outcomes you trust:

```bash
INTELLIGENCE_ALLOW_OUTREACH_ROUTING=true
```

Leave these as they are. Live-site mutation is a separate decision with its own
operator sign-off, and the live-write job is not on `TRIGGERABLE_JOBS`:

```bash
INTELLIGENCE_ALLOW_SITE_MUTATION=false
SITE_DEPLOY_DRY_RUN=true
```

### After every phase — run the invariant pack

Each phase above ends by verifying what the database actually holds, not what
the logs said. The pack asks the questions a phase gate depends on: did every
run finish, did anything auto-execute outside the plane's vocabulary, did the
live-write job ever run, did any statistic get published below the anonymity
floor.

```bash
DATABASE_URL=postgres://... npx tsx scripts/intelligence/verify-invariants.ts
# or, from a checkout with the env already loaded:
npm run verify:intelligence
```

Every invariant is phrased so that **rows mean a violation** — there is no
expected count to interpret. Exit codes: `0` clean, `1` at least one violation,
`2` the pack itself could not run. A query that ERRORS is reported as a finding,
never as a pass: a check against a relation that does not exist must never read
as "nothing wrong".

The session is read-only twice over — every query is keyword-checked before it
is sent, and the connection sets `default_transaction_read_only`. It is safe to
run against production.

Add `--json` for machine-readable output, or `--only=INTEL-04` to re-run one
check after a fix. Each finding prints its id; `INTEL-04` and `INTEL-05` are the
approval-boundary checks, `INTEL-06` is the live-write check, and `REPORT-01`
and `REPORT-02` are the two levels of the k-anonymity floor.

**Do not advance a phase with an open finding.** A violation at any rung means
the rung below it was not doing what its gate claimed.

### Rolling back

In order, and safe to stop after any step.

1. **Lower the mode.** `INTELLIGENCE_MODE=off` plus a restart stops all plane
   activity. This is the fast path and needs no deploy.
2. **Revert the code.** The jobs and views disappear with the code that
   registers them. Rows already written stay and are simply not read.
3. **Do not drop the tables to roll back.** They are additive and harmless, and
   dropping them destroys the forensic record of what the bot concluded — which
   is exactly what you need to understand why you rolled back. Drop them only
   after exporting the rows, and only if the schema itself is the problem.

## Disaster Recovery & Troubleshooting

### Scenario A: Bot is burning too many tokens
1. Check current usage: `curl http://localhost:3100/api/token-budget`
2. The circuit breaker will automatically pause LLM calls at $5/day.
3. To lower the limit, edit `.env` (add `DAILY_BUDGET_LIMIT=2.00`) and restart:
   `./scripts/deploy.sh restart`

### Scenario B: PostHog is using too much memory
ClickHouse can be memory-hungry. If the VPS crashes due to OOM (Out of Memory):
1. SSH into the VPS.
2. Run `docker stats` to confirm ClickHouse is the culprit.
3. Edit `docker-compose.yml` to add memory limits to the `clickhouse` service.
4. Restart the stack.
5. Consider upgrading to a Hetzner CX42 (8 vCPU / 16 GB RAM).

### Scenario C: Database Corruption
If PostgreSQL becomes corrupted:
1. Stop the stack: `./scripts/deploy.sh stop`
2. Restore from the latest automated backup:
   ```bash
   gunzip -c data/backups/l9_seo_bot_YYYYMMDD_HHMMSS.sql.gz | docker run -i --rm postgres:16-alpine psql -U l9admin -h your-vps-ip l9_seo_bot
   ```
3. Restart the stack.

## Maintenance

### Updating the Bot Code
When a new version of the L9 SEO Bot is pushed to GitHub:

```bash
cd l9-seo-bot
./scripts/deploy.sh update
```
This backs up the database, pulls the latest code, brings up Postgres and Redis, rebuilds the Node.js image, **runs migrations**, and only then restarts the Bot. PostHog and the database stay up throughout.

The migration step runs in a throwaway container built from the new image, so a failed migration aborts the update with the previous bot container still serving — rather than starting new code against a schema it does not match.

### Backing Up the Database
Backups are critical. Run a manual backup before any major update:

```bash
./scripts/deploy.sh backup
```
Backups are saved to `data/backups/` and the script automatically prunes backups older than 7 days.

## Environment Variable Reference

Runtime config is loaded from the environment / Infisical (see `src/core/secrets.ts`),
not from committed files. Names below match `src/core/config.ts` and `.env.example`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | Yes | `development` or `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string for BullMQ |
| `OPENAI_API_KEY` | Yes | LLM strategic reasoning |
| `DATAFORSEO_LOGIN` | Yes | SERP tracking and competitor analysis |
| `DATAFORSEO_PASSWORD` | Yes | SERP tracking and competitor analysis |
| `HUNTER_API_KEY` | No | Email extraction for link building |
| `POSTHOG_API_URL` | Yes | Self-hosted PostHog base URL (Query API) |
| `POSTHOG_PERSONAL_API_KEY` | Yes | Shared PostHog **personal** key (`phx_*`) for HogQL / Query API |
| `NODE_AUTH_TOKEN` | Dev/agent | GitHub Packages token for `@quantum-l9/*` (see below) |
| `SMTP_HOST` | No | Notification delivery |
| `SMTP_USER` | No | Notification delivery |
| `SMTP_PASS` | No | Notification delivery |
| `TELEGRAM_BOT_TOKEN` | No | Emergency alerts |
| `TELEGRAM_CHAT_ID` | No | Emergency alerts |
| `OPERATOR_API_KEY` | Yes | Operator API/dashboard auth; also the operator audience on `/api/reporting/*` |
| `REPORTING_AGENT_API_KEY` | No | Opt-in agent audience for `/api/reporting/*` (masked projections only). Must differ from `OPERATOR_API_KEY` — startup fails if they match |
| `INTELLIGENCE_MODE` | No | Default `off`. Rollout ladder: `off` / `observe` / `recommend` / `route_safe` / `route_llm` / `full`. See **Intelligence Plane — Staged Cutover** |
| `INTELLIGENCE_ALLOW_OUTREACH_ROUTING` | No | Default off. Permits queueing `links:process-outreach`. Needs `route_safe`+ as well; no mode grants it alone. Only `true`/`1` enable |
| `INTELLIGENCE_ALLOW_SITE_MUTATION` | No | Default off. Permits queueing live-site writes. Needs `route_safe`+ as well; the live-write job is separately excluded from `TRIGGERABLE_JOBS`. Only `true`/`1` enable |
| `INTELLIGENCE_MIN_OPPORTUNITY_SCORE` | No | Default `20`. Minimum score eligible to become a proposal |
| `INTELLIGENCE_MAX_ACTIONS_PER_RUN` | No | Default `3`. Per-client proposal ceiling per run; `0` stops proposals, keeps observation |
| `INTELLIGENCE_SIGNAL_COOLDOWN_DAYS` | No | Default `7`. Fingerprint suppression window (CRITICAL findings are never suppressed) |
| `INTELLIGENCE_BASELINE_DAYS` | No | Default `14`. Attribution baseline window |
| `INTELLIGENCE_MEASUREMENT_DAYS` | No | Default `28`. Attribution measurement window |
| `INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS` | No | Default `30`. Age at which a non-recurring opportunity is marked `expired`. MUST exceed `INTELLIGENCE_SIGNAL_COOLDOWN_DAYS` — registration fails if it does not |
| `INTELLIGENCE_LLM_PLANNING_ENABLED` | No | Default off (`true`/`1` to enable). The plane's only token-spending step: ranks remedies for proposals awaiting approval. Off, every proposal keeps its deterministic template action |
| `INTELLIGENCE_SYNTHESIS_BATCH_SIZE` | No | Default `10`. Proposals per synthesis sweep sent for model ranking |

### Secrets model (PostHog + packages)

Keep credential planes separate (SEO-Bot#18 / #17):

| Credential | Home | Notes |
|---|---|---|
| Per-client PostHog **project** key (`phc_*`) | DB `clients.posthog_api_key` | Tracking snippet + readiness gate; never returned by operator API |
| Per-client PostHog **personal** key (`phx_*`) | Same column when tenant has its own PostHog org | Query API override via `resolvePostHogQueryApiKey` |
| Shared `POSTHOG_PERSONAL_API_KEY` | Infisical + GitHub org/Actions secrets | Default Query API key for the shared self-hosted instance |
| `NODE_AUTH_TOKEN` (GitHub Packages) | Agent: AWS `openclaw-igorbot/github#token` → env; CI: `GITHUB_TOKEN` with `packages: read` | Not committed; see `scripts/ensure-npm-auth.sh` |

### Private npm packages (`@quantum-l9/*`)

```bash
# Preferred in governed agent environments (loads from AWS, never echoes the value):
source scripts/ensure-npm-auth.sh
npm ci --no-audit --no-fund --ignore-scripts
```

CI already sets `NODE_AUTH_TOKEN` from `secrets.GITHUB_TOKEN` (`permissions.packages: read`).
Do **not** ask humans for a second PAT when AWS `openclaw-igorbot/github#token` resolves.

## Infisical

Secrets hydrate via `src/core/secrets.ts` → `@quantum-l9/infisical-config`
(`hydrateSecretsIfConfigured`, `overwrite: false` — same contract as Website-Bot ADR-0009).
See `adr/ADR-0009-infisical-secrets-plane.md`.

**Bootstrap (required for vault hydration):** `INFISICAL_CLIENT_ID`,
`INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID` (+ optional `INFISICAL_ENV=prod`).

| Surface | Source |
|---|---|
| GitHub Actions | Repo secrets `INFISICAL_*` injected into `autonomy-ops.yml` (and any runtime job) |
| Agents / local | AWS `openclaw-igorbot/infisical-seo-bot#client_id|client_secret|project_id` via `l9-aws-secrets` → export `INFISICAL_*` |
| Vault contents | SEO-Bot Infisical project only — **not** the Website-Bot project |

After creating or rotating the Infisical project in the UI, update Actions
`INFISICAL_PROJECT_ID` and the AWS secret `project_id` to match. Upsert secret
**names** that match app env vars (`POSTHOG_PERSONAL_API_KEY`, `DATABASE_URL`, …).
Caller-set Actions env still wins until you remove those keys from the workflow.
Bootstrap for vault hydration: `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`
(AWS `openclaw-igorbot/infisical-seo-bot#…`). Put shared `POSTHOG_PERSONAL_API_KEY` in the
SEO-Bot Infisical project (`prod`); agents resolve bootstrap via `l9-aws-secrets` — do not paste PostHog values by hand when resolve works.
