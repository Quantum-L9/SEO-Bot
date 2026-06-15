# Architectural Decision Log

This document provides a human-readable rollup of all major architectural decisions made during the design and development of the L9 SEO Bot. For detailed rationale and consequences, refer to the individual ADR files in the `adr/` directory.

| ID | Topic | Decision Summary | Status |
|----|-------|------------------|--------|
| **D001** | Single-Purpose Bot | The SEO Bot is a dedicated, headless background worker that handles SEO operations exclusively. It does not build sites or manage general CMS content, separating SEO logic from Astro deployment infrastructure. | accepted |
| **D002** | Multi-Tenant Architecture | A single centralized instance of the Bot manages all client domains, allowing for cost efficiency and cross-portfolio intelligence sharing, rather than deploying isolated instances per client. | accepted |
| **D003** | Tiered LLM Token Efficiency | 95% of operations use zero-token deterministic code. LLM usage is split into a cheap 'fast' tier for classification and an expensive 'strategic' tier for generation, bounded by a strict daily circuit breaker. | accepted |
| **D004** | BullMQ Job Queue | All asynchronous tasks are orchestrated via Redis-backed BullMQ, providing persistence, concurrency control, rate limiting, and client fan-out capabilities. | accepted |
| **D005** | PostHog Behavior Intelligence | We deploy a self-hosted PostHog instance alongside the Bot to capture engagement metrics (time on page, conversion paths) without vendor lock-in or data egress costs, feeding this data directly into the SEO engine. | accepted |
| **D006** | Competitor Kill-Chain | The Bot autonomously detects when a competitor takes the #1 spot, runs a 6-dimension gap analysis, generates a surpass plan via LLM, and queues the necessary actions. | accepted |

## Pending Decisions (Decision Backlog)

The following decisions remain unresolved and require operator input before full production canonicalization:

- **B001:** Final API key selection (DataForSEO plan, OpenAI org).
- **B002:** SMTP provider selection (SendGrid vs Mailgun vs SES).
- **B003:** PostHog retention policy (duration before purging event data).
- **B004:** Backup strategy (off-site destination for PostgreSQL dumps).
- **B005:** SSL/TLS termination (Caddy, nginx, or Cloudflare Tunnel for exposing the API/PostHog).
- **B006:** External monitoring stack (Uptime Kuma, Grafana) to watch the Bot itself.
- **B007:** Formal software license selection.
