# L9 SEO Bot

**Enterprise-grade autonomous SEO engine with PostHog behavior intelligence.**

A dedicated, single-purpose SEO expert that runs 24/7 on a Hetzner CX32 VPS, managing multi-tenant client sites with minimal token burn and maximum autonomy.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Hetzner CX32 (4 vCPU / 8 GB RAM)            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │  L9 SEO Bot      │  │  PostHog         │  │  PostgreSQL  │ │
│  │  (Node.js/TS)    │  │  (Analytics)     │  │  (State)     │ │
│  │                  │  │                  │  │              │ │
│  │  5 Modules:      │  │  - Events        │  │  - Rankings  │ │
│  │  • SERP Intel    │  │  - Sessions      │  │  - Vitals    │ │
│  │  • Web Vitals    │  │  - Recordings    │  │  - Prospects │ │
│  │  • AEO/GEO       │  │  - Funnels       │  │  - Citations │ │
│  │  • Link Building │  │  - Heatmaps      │  │  - Outcomes  │ │
│  │  • Behavior Intel│  │                  │  │              │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────────┘ │
│           │                      │                              │
│  ┌────────┴──────────────────────┴─────────────────────────┐   │
│  │                    Redis (BullMQ Job Queue)              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ClickHouse (PostHog Event Storage)          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   [DataForSEO]        [Google APIs]         [Client Sites]
   [Hunter.io]         [Perplexity]          [Astro/WP]
   [OpenAI/Claude]     [SMTP]               [PostHog JS]
```

---

## Token Efficiency Model

95% of operations are pure code (zero tokens). LLM is invoked surgically:

| Tier | Engine | Cost/Call | When Used |
|------|--------|-----------|-----------|
| **Deterministic** | Pure code | $0 | Rank checks, vitals polling, DB writes, threshold comparisons |
| **Fast** | GPT-4o-mini | ~$0.001 | Relevance scoring, classification, JSON extraction |
| **Strategic** | GPT-4o/Claude | ~$0.01-0.03 | Content generation, surpass plans, outreach pitches |

Monthly budget enforcement: configurable per-client daily/monthly caps with automatic fallback to deterministic-only mode when budget exhausted.

---

## Quick Start (Hetzner CX32)

### 1. Provision VPS

```bash
# Order Hetzner CX32: 4 vCPU, 8 GB RAM, 80 GB disk, Ubuntu 22.04
# Cost: ~€7.50/mo (~$8/mo)
```

### 2. Initial Setup

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Clone the repo
git clone https://github.com/your-org/l9-seo-bot.git
cd l9-seo-bot

# Copy and configure environment
cp .env.example .env
nano .env  # Fill in your API keys

# Run setup (installs Docker if needed, builds images, runs migrations)
chmod +x scripts/deploy.sh
./scripts/deploy.sh setup
```

### 3. Start Everything

```bash
./scripts/deploy.sh start
```

### 4. Add Your First Client

```bash
docker compose exec l9-seo-bot pnpm add-client
```

### 5. Verify

```bash
./scripts/deploy.sh status
# Should show all services healthy

# Check the API
curl http://localhost:3100/health
```

---

## Modules

### Module 1: SERP Intelligence
- Tracks keyword rankings daily via DataForSEO
- Identifies #1 competitor per keyword
- Runs automated 6-dimension gap analysis
- Generates surpass plans via strategic LLM
- Monitors execution results and iterates

### Module 2: Web Vitals
- Multi-signal tracking: PageSpeed Insights + CrUX + RUM + Search Console
- Automated regression detection
- Cross-signal disagreement alerts
- Performance trend analysis

### Module 3: AEO/GEO (AI Search Optimization)
- 40-60 word extractable answer blocks
- FAQPage schema injection
- Self-query feedback loop (checks Perplexity/ChatGPT citations)
- Statistical density scoring
- Monthly content freshness updates

### Module 4: Link Building
- Competitor backlink gap analysis (DataForSEO)
- Email discovery (Hunter.io)
- Personalized pitch generation (LLM)
- Automated outreach sequences
- Safety: velocity governor, DR gate, circuit breaker

### Module 5: Behavior Intelligence (PostHog)
- Daily engagement data pull (zero tokens)
- Page performance scoring (time × scroll depth)
- Dead-end detection (high exit rate pages)
- Conversion path identification
- Weekly strategic insights (LLM, Fridays only)
- Cross-portfolio benchmarking

---

## Client Site Integration

Add this snippet to your Astro site's `<head>`:

```html
<!-- See client-snippets/posthog-tracking.html for the full snippet -->
```

This captures:
- Page views with timing
- Scroll depth
- Core Web Vitals (LCP, INP, CLS, FCP, TTFB)
- Click events
- Form submissions

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/clients` | GET | List all clients |
| `/api/clients/:id` | GET | Client detail with latest data |
| `/api/clients/:id/report` | GET | Weekly performance report |
| `/api/clients/:id/trigger` | POST | Manually trigger a module |
| `/api/token-budget` | GET | Token usage status |
| `/api/reporting/views` | GET | Named queries the calling audience may run |
| `/api/reporting/query` | POST | Run one named query (see below) |
| `/api/reporting/refresh-status` | GET | Freshness of the materialized views |
| `/dashboard/intelligence` | GET | What the bot concluded this week, and whether it worked |

### Reporting queries

Cross-client, date-range, and join questions that the endpoints above do not
expose are served by the reporting SQL plane (ADR-0015) — not by handing out a
database connection string. A caller names a view and supplies validated
filters; it never supplies SQL, a column, or an ORDER BY.

```bash
curl -s https://bot.example/api/reporting/query \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"view":"keyword_drops_7d","filters":{"min_delta":10},"limit":25}'
```

Two audiences, chosen by the credential presented, never by the request body:

| Credential | Audience | Sees |
|---|---|---|
| `OPERATOR_API_KEY` | operator | Client names, domains, contact details |
| `REPORTING_AGENT_API_KEY` | agent | Masked projections only — no client identity, no PII, no credentials |

The agent surface is opt-in: leave `REPORTING_AGENT_API_KEY` unset and agents
have no access. `GET /api/reporting/views` returns the filter, ordering, and row
limit contract for everything the caller can reach, so no schema dump is needed.

### Portfolio benchmarks

`portfolio_benchmarks` answers the one question the per-tenant views cannot:
*is this number good?* It reports median, p25 and p75 for SERP position, LCP,
exit rate, and answer-engine citation rate across a cohort of
**industry × country × state × month**.

```bash
curl -s https://bot.example/api/reporting/query \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"view":"portfolio_benchmarks","filters":{"industry":"legal","state":"nc","days":90}}'
```

A cohort statistic is only safe if the cohort is large enough to hide the
clients in it, so **a k-anonymity floor of 5 applies twice**: a cohort with
fewer than five clients returns no row at all, and each individual metric is
suppressed unless five clients contributed *that metric*. A cohort of five
clients where only two have Core Web Vitals data publishes no LCP percentile —
the alternative is a two-client disclosure wearing a five-client label.

An empty benchmark on a small portfolio is therefore the expected result, not a
fault. `portfolio_cohort_coverage` says which cohorts exist and which cleared
the floor (never how far below a suppressed one sits), and the weekly
`intel:weekly-portfolio` run records the same counts on `intelligence_runs` so
the answer is in the history rather than only in a live query.

No column of either view carries a client id, name, or domain, so both are
readable by the agent audience.

### Reviewing what the bot decided

`/dashboard/intelligence` answers "what did the bot do this week, and did it
work?" without opening psql: open work by score, the last seven days of
decisions with the rationale behind each, attribution windows still counting
down, and measured outcomes with the learning the memory promoter reads.
Materialized-snapshot age is shown inline — an operator reading a stale number
without knowing it is stale is worse served than one shown no number.

The page reads through the reporting gateway rather than the intelligence
tables, so it is audited, read-only and timeout-bounded like every other
consumer. A panel whose view is missing says so in its own box instead of taking
the page down with it.

---

## Cron Schedule

| Job | Frequency | Token Cost |
|-----|-----------|------------|
| SERP tracking | Daily 6 AM | 0 (API only) |
| Competitor analysis | Weekly Monday | ~3000 strategic |
| Web Vitals check | Every 6 hours | 0 (API only) |
| Citation check | Weekly Wednesday | ~500 fast |
| FAQ optimization | Monthly 1st | ~6000 strategic |
| Prospect discovery | Weekly Tuesday | ~1000 fast |
| Outreach processing | Daily 10 AM | ~3000 strategic |
| Behavior data pull | Daily midnight | 0 (API only) |
| Behavior insights | Weekly Friday | ~4000 strategic |
| Intelligence triage | Daily 7:30 AM | 0 (deterministic SQL) |
| Outcome attribution | Daily 4 AM | 0 (deterministic SQL) |
| Policy state refresh | Every 4 hours | 0 (deterministic SQL) |
| Lifecycle sweep | Hourly | 0 (deterministic SQL) |
| Portfolio benchmark | Weekly Monday 7:45 AM | 0 (deterministic SQL) |
| Reporting view refresh | Every 6 hours | 0 (deterministic SQL) |

**Estimated monthly token cost per client: ~$2-5**

The intelligence plane adds no token cost of its own: extraction, scoring, and
the policy gate are deterministic. Tokens are spent only by the module jobs it
queues, under those jobs' existing budgets.

---

## Operations

```bash
# View logs
./scripts/deploy.sh logs              # Bot logs
./scripts/deploy.sh logs posthog      # PostHog logs

# Backup database
./scripts/deploy.sh backup

# Update bot code
./scripts/deploy.sh update

# Restart everything
./scripts/deploy.sh restart
```

---

## Required API Keys

| Service | Purpose | Cost |
|---------|---------|------|
| DataForSEO | SERP tracking, backlink analysis | ~$50/mo (1000 requests) |
| Google PageSpeed Insights | Web Vitals (lab data) | Free |
| Google Search Console | Real ranking data | Free |
| Hunter.io | Email discovery | Free tier: 25/mo |
| Perplexity API | AI citation checking | ~$5/mo |
| OpenAI | Strategic LLM calls | ~$10-20/mo |
| SMTP (any provider) | Outreach emails | ~$5/mo |

**Total estimated monthly cost: ~$80-100/mo for 10 clients**
(VPS $8 + APIs ~$75 + tokens ~$20)

---

## License

Proprietary - L9 Systems
