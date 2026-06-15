# ADR-0001: Single-Purpose Dedicated SEO Bot

## Status
accepted

## Date
2026-06-14

## Context
The L9 Website Factory generates high-performance Astro sites, but maintaining search rankings requires continuous, aggressive optimization. Previous approaches mixed site building, content management, and SEO operations into monolithic workflows (e.g., OpenClaw). This caused operational complexity, high token burn, and difficulty in scaling across multiple clients. We needed a clean separation of concerns where the SEO maintenance engine operates independently of the site generation and hosting infrastructure.

## Decision
We will build the L9 SEO Bot as a single-purpose, dedicated, headless background worker. It will focus exclusively on SEO operations (SERP tracking, Web Vitals monitoring, AEO/GEO optimization, Link Building, and Behavior Intelligence) and will not participate in site building, deployment, or general content management.

## Rationale
- **Separation of Concerns:** By decoupling SEO from site generation, the Bot can run continuously without interfering with site deployments.
- **Technology Alignment:** Astro is optimal for serving sites (zero JS), while Node.js is optimal for running continuous background API polling and cron jobs.
- **Security:** The Bot operates headlessly via APIs (DataForSEO, Google APIs, PostHog) and only requires specific scoped access, reducing the blast radius if compromised.
- **Scalability:** A single-purpose Bot can easily fan-out its operations across multiple client domains from a single centralized instance.

## Consequences
- The Bot requires its own persistent hosting environment (Hetzner CX32) separate from the client sites.
- The Bot cannot directly modify Astro source code; it must rely on APIs (like WordPress REST API or GitHub Actions triggers) if content changes are needed.
- OpenClaw is relegated strictly to tasks lacking API access (e.g., Google Business Profile updates).

## Alternatives Considered
- **OpenClaw Monolith:** Rejected due to high token cost, fragility of browser automation, and lack of true concurrency.
- **Serverless Functions (Vercel/AWS Lambda):** Rejected due to the need for persistent state, long-running LLM generation tasks, and complex orchestration that exceeds typical serverless timeouts.

## Validation / Evidence
- `README.md` clearly defines the scope as an "autonomous SEO engine".
- `package.json` names the project `l9-seo-bot`.
- `src/modules/` contains only SEO-specific capabilities.

## Related Artifacts
- `README.md`
- `src/modules/*`

## Open Questions
- How will the Bot autonomously push content updates to static Astro sites without triggering full rebuilds for minor changes? (Deferred to future integration with a headless CMS or GitHub API).
