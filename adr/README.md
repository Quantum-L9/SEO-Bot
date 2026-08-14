# Architecture Decision Records (ADRs)

This directory contains the canonical Architecture Decision Records for the L9 SEO Bot. These documents capture the major architectural, operational, and strategic decisions that define the system's behavior and constraints.

## Index

| ADR | Topic | Status | Date |
|-----|-------|--------|------|
| [ADR-0001](ADR-0001-single-purpose-dedicated-bot.md) | Single-Purpose Dedicated SEO Bot | accepted | 2026-06-14 |
| [ADR-0002](ADR-0002-multi-tenant-architecture.md) | Multi-Tenant Architecture | accepted | 2026-06-14 |
| [ADR-0003](ADR-0003-tiered-llm-token-efficiency.md) | Tiered LLM Token Efficiency | accepted | 2026-06-14 |
| [ADR-0004](ADR-0004-bullmq-job-queue-architecture.md) | BullMQ Job Queue Architecture | accepted | 2026-06-14 |
| [ADR-0005](ADR-0005-posthog-behavior-intelligence.md) | PostHog Behavior Intelligence | accepted | 2026-06-14 |
| [ADR-0006](ADR-0006-competitor-kill-chain.md) | Competitor Kill-Chain Pattern | accepted | 2026-06-14 |
| [ADR-0007](ADR-0007-reproducible-assurance.md) | Reproducible Assurance | accepted | 2026-07-19 |
| [ADR-0008](ADR-0008-autonomy-runtime-controls.md) | Autonomy Runtime Controls | proposed | 2026-07-15 |
| [ADR-0009](ADR-0009-infisical-secrets-plane.md) | Infisical Secrets Plane | accepted | 2026-08-11 |
| [ADR-0010](ADR-0010-build-time-website-intelligence-interface.md) | Build-Time Website Intelligence Interface | accepted | 2026-08-14 |
| [ADR-0011](ADR-0011-search-reasoning-and-provider-isolation.md) | Search, Reasoning, and Provider Isolation | accepted | 2026-08-14 |
| [ADR-0012](ADR-0012-competitive-landscape-authority.md) | CompetitiveLandscape Ranking Authority | accepted | 2026-08-14 |
| [ADR-0013](ADR-0013-seo-content-blueprint-and-content-compiler.md) | SEOContentBlueprint and Strategic Content Compiler | accepted | 2026-08-14 |
| [ADR-0014](ADR-0014-answer-engine-observation.md) | Answer Engine Observation Measurement Adapter | accepted | 2026-08-14 |

> ADR-0010–ADR-0014 form the `redesign-improve/v1` architecture pack
> (accepted 2026-08-14). They amend ADR-0001 and ADR-0003; ADR-0001 through
> ADR-0009 remain in force except where explicitly amended.

## Format

All ADRs must follow the standard format defined in `CONTRIBUTING.md`, including Title, Status, Date, Context, Decision, Rationale, Consequences, Alternatives Considered, Validation/Evidence, Related Artifacts, and Open Questions.
