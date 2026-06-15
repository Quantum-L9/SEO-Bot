# Decision Extraction - L9 SEO Bot

## Extracted Decisions (mapped to pack evidence)

| ID | Topic | Decision | Evidence Source | Status |
|----|-------|----------|-----------------|--------|
| D001 | Single-purpose dedicated Bot | Bot does SEO only — no site building, no content management, no deployment | `README.md` scope, `package.json` name, all modules scoped to SEO | accepted |
| D002 | Multi-tenant architecture | One Bot instance serves all clients via per-client fan-out | `scheduler.ts` clientScoped fan-out, `schema.ts` clients table, `types/index.ts` Client interface | accepted |
| D003 | Tiered LLM token efficiency | 95% deterministic code, LLM invoked only for judgment; two tiers: fast (classification) and strategic (generation) | `llm.ts` tiered architecture, `scheduler.ts` tokenBudget per job, `README.md` token model | accepted |
| D004 | Daily budget enforcement | Hard $5/day cap with automatic circuit breaker; prevents runaway costs | `llm.ts` dailyBudgetLimit, dailySpend tracking, budget exceeded throw | accepted |
| D005 | BullMQ job queue architecture | All work dispatched via Redis-backed BullMQ with cron scheduling, rate limiting, and concurrency control | `scheduler.ts` Queue/Worker/cron, `docker-compose.yml` Redis service | accepted |
| D006 | Per-job token budgets | Each job definition declares maxFastTokens and maxStrategicTokens per run | `types/index.ts` TokenBudget, `scheduler.ts` JOB_DEFINITIONS | accepted |
| D007 | Docker Compose co-located stack | All services (Bot, PostHog, PostgreSQL, Redis, ClickHouse) on single VPS via Docker Compose | `docker-compose.yml` full stack, `README.md` architecture diagram | accepted |
| D008 | Hetzner CX32 target deployment | 4 vCPU / 8 GB RAM / 80 GB disk at ~$8/mo as the deployment target | `README.md` Quick Start, `deploy.sh` setup script | accepted |
| D009 | PostHog self-hosted for behavior analytics | Self-hosted PostHog (not cloud) for zero data egress cost and full API access | `docker-compose.yml` posthog service, `client-snippets/posthog-tracking.html` | accepted |
| D010 | Shared PostHog instance (all clients) | One PostHog instance with per-client projects, not per-client PostHog | `README.md` architecture, `behavior-intelligence/index.ts` project-scoped queries | accepted |
| D011 | Five-module architecture | SERP Intel, Web Vitals, AEO/GEO, Link Building, Behavior Intelligence | `src/modules/` directory structure, `types/index.ts` ModuleName union | accepted |
| D012 | Competitor kill-chain pattern | Identify #1 → gap analysis (6 dimensions) → LLM surpass plan → execute → monitor → iterate | `serp-intelligence/index.ts` analyzeCompetitors + generateSurpassPlan, `types/index.ts` GapDimension | accepted |
| D013 | Multi-signal Web Vitals | Four independent sources: PSI, CrUX, RUM (PostHog), Search Console | `web-vitals/index.ts` source union, `types/index.ts` WebVitalsReport.source | accepted |
| D014 | AEO citation self-query loop | Bot queries Perplexity/ChatGPT to check if client content is being cited by AI | `aeo-geo/index.ts` checkCitations, `types/index.ts` AeoCitationCheck | accepted |
| D015 | Link velocity governor | Domain-age-aware rate limiting with anchor distribution enforcement | `types/index.ts` LinkVelocityConfig, `link-building/index.ts` velocity checks | accepted |
| D016 | Circuit breaker on ranking drops | If rankings drop >30%, pause all link building and trigger investigation | `link-building/index.ts` circuit breaker logic | accepted |
| D017 | Outreach sequence automation | Multi-step email sequences (initial + follow-ups) with tracking | `types/index.ts` OutreachStep, ProspectStatus state machine | accepted |
| D018 | Zod-validated configuration | All env vars validated at startup via Zod; fail-fast on invalid config | `config.ts` envSchema, safeParse, process.exit(1) | accepted |
| D019 | Structured logging (pino) | JSON structured logs with module context for observability | `logger.ts` pino configuration, createModuleLogger | accepted |
| D020 | Drizzle ORM with PostgreSQL | Type-safe database access with migration support | `database/schema.ts`, `database/index.ts`, `drizzle.config.ts` | accepted |
| D021 | Operator notification system | Multi-channel alerts (email + Telegram) with configurable thresholds | `notifications.ts`, `types/index.ts` NotificationConfig | accepted |
| D022 | REST API for operator dashboard | Lightweight Fastify API exposing health, client data, reports, and manual triggers | `api/index.ts` endpoints | accepted |
| D023 | Action outcome feedback loop | Every action's result is measured against ranking/traffic changes to learn what works | `types/index.ts` ActionOutcome, `schema.ts` actionOutcomes table | accepted |
| D024 | Client-scoped job fan-out | Scheduler detects clientScoped jobs and automatically fans out to all active clients | `scheduler.ts` processJob fan-out logic | accepted |
| D025 | OpenClaw reserved for API-less platforms only | Browser automation only for GBP and legacy directories; everything else headless | `README.md` architecture notes (implicit from design) | accepted |

## Decision Backlog (Unknown / needs operator input)

| ID | Topic | Reason | Owner | Next Action |
|----|-------|--------|-------|-------------|
| B001 | Final API key selection | Which DataForSEO plan, which OpenAI org | operator | Provide credentials |
| B002 | SMTP provider selection | SendGrid vs Mailgun vs SES | operator | Choose provider, add credentials |
| B003 | PostHog retention policy | How long to retain event data before purging | operator | Define retention period |
| B004 | Backup strategy | Off-site backup destination (S3? Hetzner Storage Box?) | operator | Choose backup target |
| B005 | SSL/TLS termination | How to expose PostHog and API externally (Caddy? nginx? Cloudflare Tunnel?) | operator | Choose reverse proxy |
| B006 | Monitoring/alerting for the Bot itself | Who watches the watcher? (Uptime Kuma? Grafana?) | operator | Choose monitoring stack |
| B007 | License | Proprietary stated but no formal license file | operator | Confirm license terms |
