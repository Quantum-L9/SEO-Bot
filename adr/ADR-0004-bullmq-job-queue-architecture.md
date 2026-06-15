# ADR-0004: BullMQ Job Queue Architecture

## Status
accepted

## Date
2026-06-14

## Context
The SEO Bot must execute dozens of distinct tasks across multiple clients, ranging from rapid API polling to long-running LLM generation tasks. Relying on simple `setInterval` or in-memory cron jobs would lead to overlapping executions, memory exhaustion, and lost jobs if the Bot restarts. We need a robust, persistent job orchestration system.

## Decision
We will use BullMQ backed by Redis as the core scheduling and execution engine. All tasks will be modeled as distinct job definitions with cron schedules, concurrency limits, and rate limiting.

## Rationale
- **Persistence:** Redis ensures jobs survive Bot restarts or crashes.
- **Concurrency Control:** BullMQ allows us to limit how many jobs of a specific type run simultaneously, preventing API rate limits (e.g., DataForSEO) from being breached.
- **Retries and Backoff:** Built-in support for retrying failed API calls with exponential backoff.
- **Fan-out Capability:** The scheduler can intercept a master cron job and spawn individual child jobs for every active client.

## Consequences
- Requires Redis as a hard infrastructure dependency.
- Job handlers must be written idempotently, as they may be retried upon failure.
- Increases the complexity of the Bot's startup and shutdown sequence to gracefully handle active workers.

## Alternatives Considered
- **In-memory node-cron:** Rejected due to lack of persistence, retries, and distributed concurrency control.
- **PostgreSQL-based queues (e.g., Graphile Worker):** Considered, but BullMQ is generally faster and has better ecosystem support for complex rate limiting scenarios.

## Validation / Evidence
- `src/core/scheduler.ts` heavily utilizes `Queue`, `Worker`, and `Job` from the `bullmq` package.
- `docker-compose.yml` includes a dedicated `redis` service.

## Related Artifacts
- `src/core/scheduler.ts`
- `docker-compose.yml`

## Open Questions
- None.
