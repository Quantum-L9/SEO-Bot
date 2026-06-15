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

**Estimated monthly token cost per client: ~$2-5**

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
