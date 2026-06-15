# ADR-0002: Multi-Tenant Architecture

## Status
accepted

## Date
2026-06-14

## Context
As the agency scales, deploying a separate SEO Bot instance for every client site becomes operationally unmanageable and financially inefficient. Each instance requires its own VPS, database, queue, and monitoring setup. Furthermore, isolated instances prevent cross-portfolio learning and benchmarking.

## Decision
The L9 SEO Bot will use a multi-tenant architecture. A single centralized instance of the Bot, running on a single VPS, will manage all client domains.

## Rationale
- **Cost Efficiency:** One Hetzner CX32 (~$8/mo) can comfortably handle 10-20 clients, rather than paying $8/mo per client.
- **Operational Simplicity:** One codebase to update, one database to backup, one set of logs to monitor.
- **Cross-Portfolio Intelligence:** Centralizing data in one PostgreSQL and one PostHog instance allows the Bot to run aggregate analytics, establishing industry benchmarks (e.g., "average bounce rate for roofing sites") that improve decision-making for all clients.
- **Resource Utilization:** Scheduled jobs can be staggered or fanned out efficiently without idling resources on 20 different machines.

## Consequences
- The database schema must enforce strict tenant isolation (`clientId` on every row) to prevent data leakage between clients.
- The scheduler must support a "fan-out" pattern where a single cron trigger spawns individual jobs for every active client.
- A rogue or heavy job for one client could potentially consume resources needed by others (mitigated by BullMQ concurrency limits).

## Alternatives Considered
- **Single-Tenant (One Bot per Site):** Rejected due to massive infrastructure overhead, cost, and inability to share intelligence.
- **Serverless Multi-Tenant:** Rejected due to persistent state requirements and long-running job limitations.

## Validation / Evidence
- `src/core/database/schema.ts` includes a `clients` table and `clientId` foreign keys on all operational tables.
- `src/core/scheduler.ts` implements explicit fan-out logic (`if (definition.clientScoped && !job.data.clientId) ...`).
- `src/types/index.ts` defines the `Client` and `ClientConfig` interfaces.

## Related Artifacts
- `src/core/scheduler.ts`
- `src/core/database/schema.ts`
- `src/types/index.ts`

## Open Questions
- None.
