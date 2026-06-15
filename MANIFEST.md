# L9 SEO Bot - Master Manifest

This document serves as the canonical inventory of the L9 SEO Bot pack. It defines the purpose and ownership of every file in the repository.

## Canonical Documentation

| File | Purpose |
|------|---------|
| `README.md` | Primary entry point, architecture overview, quickstart, and deployment guide. |
| `MANIFEST.md` | This file. Complete file inventory and artifact ownership. |
| `VALIDATION.md` | Validation gates, testing requirements, and fail-closed rules. |
| `RUNBOOK.md` | Operator execution guide, disaster recovery, and daily operations. |
| `AGENTS.md` | Instructions for AI coding/build agents working with this repository. |
| `SECURITY.md` | Security policies, API key management, and data privacy boundaries. |
| `CONTRIBUTING.md` | Rules for future pack changes and ADR additions. |
| `DECISION_LOG.md` | Human-readable rollup of all architectural decisions. |
| `PACK_INDEX.md` | Navigation map across all documentation and modules. |
| `LICENSE_NOTICE.md` | Licensing status and reuse boundaries. |

## Internal Working Documents

| File | Purpose |
|------|---------|
| `docs/decision_extraction.md` | Raw decision extraction matrix mapping pack evidence to ADR topics. |

## Architecture Decision Records (ADRs)

| File | Purpose |
|------|---------|
| `adr/README.md` | Index of all ADRs. |
| `adr/ADR-0001-single-purpose-dedicated-bot.md` | Decision to separate SEO from site building. |
| `adr/ADR-0002-multi-tenant-architecture.md` | Decision to use a single Bot instance for all clients. |
| `adr/ADR-0003-tiered-llm-token-efficiency.md` | Decision to use fast/strategic LLM tiers and budget caps. |
| `adr/ADR-0004-bullmq-job-queue-architecture.md` | Decision to use Redis-backed BullMQ for scheduling. |
| `adr/ADR-0005-posthog-behavior-intelligence.md` | Decision to self-host PostHog for engagement tracking. |
| `adr/ADR-0006-competitor-kill-chain.md` | Decision to automate competitor gap analysis and surpass planning. |

## Core Infrastructure

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Full stack definition (Bot, PostgreSQL, Redis, ClickHouse, PostHog). |
| `docker/Dockerfile` | Container build instructions for the Node.js Bot. |
| `docker/init-db.sql` | Initial database creation script. |
| `.env.example` | Template for required API keys and configuration variables. |
| `package.json` | Node.js dependencies and run scripts. |
| `tsconfig.json` | TypeScript compiler configuration. |
| `drizzle.config.ts` | Drizzle ORM migration configuration. |

## Scripts

| File | Purpose |
|------|---------|
| `scripts/deploy.sh` | One-command setup, start, stop, update, and backup script for Hetzner CX32. |
| `scripts/add-client.ts` | CLI tool for onboarding new domains into the multi-tenant system. |

## Source Code (`src/`)

### Core

| File | Purpose |
|------|---------|
| `src/index.ts` | Main application entry point. |
| `src/core/config.ts` | Zod-validated environment configuration loader. |
| `src/core/logger.ts` | Pino-based structured logging system. |
| `src/core/scheduler.ts` | BullMQ job queue, cron definitions, and client fan-out logic. |
| `src/core/database/index.ts` | Database connection and Drizzle ORM setup. |
| `src/core/database/schema.ts` | PostgreSQL table definitions (clients, rankings, vitals, etc.). |
| `src/core/database/migrate.ts` | Database migration runner. |

### Modules

| File | Purpose |
|------|---------|
| `src/modules/serp-intelligence/index.ts` | DataForSEO integration, rank tracking, and competitor kill-chain. |
| `src/modules/web-vitals/index.ts` | PSI, CrUX, RUM, and Search Console multi-signal tracking. |
| `src/modules/aeo-geo/index.ts` | FAQ optimization, schema injection, and Perplexity citation checking. |
| `src/modules/link-building/index.ts` | Prospect discovery, LLM pitch generation, and automated outreach. |
| `src/modules/behavior-intelligence/index.ts` | PostHog API integration for engagement tracking and conversion paths. |

### Services & API

| File | Purpose |
|------|---------|
| `src/services/llm.ts` | Tiered LLM integration with strict token budget enforcement. |
| `src/services/notifications.ts` | Operator alerting via Email and Telegram. |
| `src/api/index.ts` | Fastify REST API for health checks, dashboard data, and manual triggers. |
| `src/types/index.ts` | Canonical TypeScript interfaces and type definitions. |

## Client Integration

| File | Purpose |
|------|---------|
| `client-snippets/posthog-tracking.html` | Drop-in `<script>` tag for Astro sites to capture vitals and engagement. |
