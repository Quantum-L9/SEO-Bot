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
