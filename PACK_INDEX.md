# L9 SEO Bot - Pack Index

This index provides a navigational map to all documentation and modules within the L9 SEO Bot repository.

## 1. Governance & Operations
- `README.md` - Quickstart and deployment guide.
- `MANIFEST.md` - Complete file inventory and ownership.
- `VALIDATION.md` - Testing requirements and fail-closed gates.
- `RUNBOOK.md` - Daily operations, disaster recovery, and manual overrides.
- `AGENTS.md` - Rules for AI agents modifying this codebase.
- `SECURITY.md` - Data isolation, safety governors, and credential management.
- `CONTRIBUTING.md` - Rules for proposing changes and writing ADRs.

## 2. Architecture & Decisions
- `DECISION_LOG.md` - Rollup of all major architectural decisions.
- `adr/README.md` - Index of detailed Architecture Decision Records.
- `docs/decision_extraction.md` - Raw mapping of pack evidence to extracted decisions.

## 3. Core Modules (`src/modules/`)
- `serp-intelligence/` - Rank tracking and competitor gap analysis.
- `web-vitals/` - Multi-signal performance tracking (PSI, CrUX, RUM).
- `aeo-geo/` - AI search optimization and citation checking.
- `link-building/` - Autonomous prospect discovery and outreach.
- `behavior-intelligence/` - PostHog integration for engagement tracking.

## 4. Infrastructure & Integration
- `docker-compose.yml` - The full deployment stack.
- `client-snippets/posthog-tracking.html` - The tracking script to inject into client Astro sites.
- 

## Phase A — Cross-Repo Alignment (2026-06-19)
- `src/api/clients/register.ts` - Fastify plugin for webhook-based client registration with contract validation and Drizzle upsert.
- `src/api/index.ts` - Registers the new client registration route plugin in server startup.
- `contracts/schema/website_factory_v2.ts` - Zod schema and type for Website Factory contract version 2.0 payloads.
- `contracts/website_factory_integration.yaml` - Contract metadata updated for schema v2 and webhook handoff trigger.
- `contracts/posthog_events.ts` - Canonical PostHog event name constants shared across integrations.
- `.github/workflows/ci.yml` - Baseline CI workflow for build-router, typecheck, lint, and Vitest runs.
- `tests/api/register.test.ts` - Route tests covering registration success and validation failures.
- `tests/contracts/schema-v2.test.ts` - Contract schema tests for valid/invalid Website Factory v2 payloads.
- `src/services/site-deployment.ts` - GitHub Contents + Vercel deploy service for SEO metadata and JSON-LD updates.
- `scripts/check-router-sync.sh` - GitHub API drift checker comparing llm-router entrypoint SHAs across repos.
- `.github/workflows/router-drift.yml` - Scheduled and PR drift detection workflow with automatic issue creation on divergence.
