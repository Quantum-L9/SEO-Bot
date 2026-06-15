# ADR-0005: PostHog Behavior Intelligence

## Status
accepted

## Date
2026-06-14

## Context
Traditional SEO focuses on driving traffic, but does not measure what happens after the click. To truly optimize a site for conversions and identify high-value content, the SEO Bot needs access to behavioral data (time on page, scroll depth, conversion paths, dead-ends). Using a third-party SaaS analytics platform like HubSpot is expensive, creates vendor lock-in, and limits the Bot's ability to query raw data autonomously.

## Decision
We will deploy a self-hosted instance of PostHog alongside the SEO Bot on the same VPS. The Bot will query PostHog's API daily to extract engagement metrics, and use this data to prioritize SEO efforts (e.g., boosting internal links to high-converting pages, or refreshing pages with high exit rates).

## Rationale
- **Data Ownership & Cost:** Self-hosting PostHog eliminates per-event pricing and data egress costs, making it financially viable to track millions of events across the portfolio.
- **Deep Integration:** Co-locating PostHog allows the Bot to query the ClickHouse database directly or via local API calls with near-zero latency.
- **Cross-Portfolio Benchmarking:** A single shared PostHog instance containing all client data allows the Bot to learn industry-wide patterns and apply those insights to individual clients.

## Consequences
- Requires a more powerful VPS (Hetzner CX32 minimum) to run ClickHouse, PostgreSQL, Redis, and the PostHog app server.
- The deployment stack is significantly more complex, requiring a large Docker Compose setup.
- Client sites must inject a specific PostHog tracking snippet into their layouts.

## Alternatives Considered
- **Google Analytics 4 (GA4):** Rejected due to sampling, delayed data availability, and a restrictive API that makes complex behavioral path analysis difficult for an autonomous agent.
- **HubSpot:** Rejected due to high cost and API rate limits.
- **Per-Client PostHog Instances:** Rejected due to massive resource overhead (running ClickHouse 10 times) and the inability to easily run cross-portfolio queries.

## Validation / Evidence
- `docker-compose.yml` includes `posthog` and `clickhouse` services.
- `src/modules/behavior-intelligence/index.ts` exists to pull and analyze this data.
- `client-snippets/posthog-tracking.html` provides the exact integration code.

## Related Artifacts
- `docker-compose.yml`
- `src/modules/behavior-intelligence/index.ts`
- `client-snippets/posthog-tracking.html`

## Open Questions
- What is the long-term data retention policy for ClickHouse to prevent the 80GB disk from filling up?
