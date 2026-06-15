# Operator Runbook

This document explains how to operate, maintain, and troubleshoot the L9 SEO Bot in production.

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
  -H "Content-Type: application/json" \
  -d '{"module": "vitals:check-all"}'
```

Valid modules: `serp:track-rankings`, `serp:analyze-competitor`, `vitals:check-all`, `aeo:check-citations`, `aeo:optimize-faqs`, `links:discover-prospects`, `links:process-outreach`, `behavior:pull-engagement`, `behavior:generate-insights`.

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
This pulls the latest code, rebuilds the Node.js image, and restarts the Bot with zero downtime for PostHog or the database.

### Backing Up the Database
Backups are critical. Run a manual backup before any major update:

```bash
./scripts/deploy.sh backup
```
Backups are saved to `data/backups/` and the script automatically prunes backups older than 7 days.

## Environment Variable Reference

The system is configured entirely via `.env`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | Yes | `development` or `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string for BullMQ |
| `OPENAI_API_KEY` | Yes | LLM strategic reasoning |
| `DATAFORSEO_LOGIN` | Yes | SERP tracking and competitor analysis |
| `DATAFORSEO_PASSWORD` | Yes | SERP tracking and competitor analysis |
| `HUNTER_API_KEY` | No | Email extraction for link building |
| `POSTHOG_HOST` | Yes | Self-hosted PostHog instance URL |
| `POSTHOG_PROJECT_KEY` | Yes | Project key for event ingestion |
| `SMTP_HOST` | No | Notification delivery |
| `SMTP_USER` | No | Notification delivery |
| `SMTP_PASS` | No | Notification delivery |
| `TELEGRAM_BOT_TOKEN` | No | Emergency alerts |
| `TELEGRAM_CHAT_ID` | No | Emergency alerts |
