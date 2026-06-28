# L9 SEO Bot — Deployment Guide

This guide covers deploying the L9 SEO Bot v2.0.0, which now includes the embedded `@quantum-l9/llm-router` package.

## Architecture

The project is structured as a simple monorepo:
- `packages/llm-router/` — The standalone LLM routing engine
- `src/` — The SEO Bot core and modules

## Prerequisites

- A Linux VPS (Ubuntu 22.04+ recommended)
- Minimum 2 vCPU, 4 GB RAM (Hetzner CX32 recommended)
- Docker and Docker Compose installed
- Node.js 22+ (if running locally for development)

## Deployment Steps

### 1. Clone and Setup

```bash
git clone <your-repo>
cd l9-seo-bot
cp .env.example .env
nano .env # Add your API keys (OpenRouter, Perplexity, DataForSEO)
```

### 2. Automated Deployment

The provided deployment script handles building the router, building the bot, and starting the Docker stack.

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh setup
./scripts/deploy.sh start
```

### 3. Adding a Client

Once the bot is running, use the CLI tool to onboard a new domain:

```bash
npm run add-client --domain safehavenrr.com --owner "client@email.com"
```

## Manual Build Process (If not using deploy.sh)

Because of the monorepo structure, the router must be built *before* the bot:

```bash
# 1. Install dependencies
npm install

# 2. Build the router package
npm run build:router

# 3. Build the SEO Bot
npm run build

# 4. Start the stack
docker compose up -d
```

## Accessing the Dashboard

The operator dashboard is available at:
`http://<your-vps-ip>:3100/dashboard`

## Troubleshooting

**Error: Cannot find module '@quantum-l9/llm-router'**
This means the router hasn't been built yet. Run `npm run build:router` from the root directory.

**Error: BudgetExhaustedError**
Check your `.env` limits. If a client hits their cap, the bot will pause their tasks until the next budget cycle (weekly). Critical tasks will still execute).
