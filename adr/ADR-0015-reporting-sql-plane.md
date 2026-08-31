<!-- L9_META: layer=architecture, role=reporting_sql_plane_adr, status=accepted, version=1.0.0 -->
# ADR-0015: SQL Is a Governed Reporting Plane, Not a Connection String

## Status
Accepted.

## Date
2026-08-31

## Context
Postgres holds the product state: rankings, vitals, engagement, prospects,
citations, LLM spend, job executions, and the action log. The HTTP API exposes
two narrow, hard-limited slices of it — the latest rows for one client, and a
seven-day report. Every question that spans clients, spans a date range, or
joins two modules' output falls outside that surface.

The obvious response is to hand out a database connection string. It is also
wrong, for a reason visible in the schema itself: `public.clients` contains
`posthog_api_key`. A `SELECT * FROM clients` from a SQL tool or an LLM agent is
a credential disclosure, not a reporting query. The repository's own security
policy already requires every operational row to be `clientId`-scoped and treats
cross-client access as exceptional.

Three distinct consumers want SQL, and they do not want the same SQL:

| Consumer | Needs | Must never receive |
|---|---|---|
| The bot itself | Cross-module joins on a schedule | — |
| An operator at a prompt | Client names, domains, contact details | Credentials |
| An LLM agent / n8n | Portfolio shape and anomalies | Client identity, PII, credentials |

## Decision
Introduce a `reporting` schema that is a READ CONTRACT, and reach it through a
named-query gateway rather than a socket.

**1. The `reporting` schema (migration 0002).** Curated views over the
operational tables: latest ranking state, keyword drops, weekly movements, page
experience risk (vitals × engagement), citation rate, LLM spend, job failures,
pending approvals, uncontacted prospects. Two client dimensions —
`clients_safe` (name, domain) and `clients_agent` (a SHA-256 reference,
industry, market). No view selects a PostHog credential. Operational tables
remain write-owned by Drizzle and the BullMQ workers.

**2. Explicit per-audience column projections.** The registry
(`src/reporting/views.ts`) declares, per view, exactly which columns the
`operator` and `agent` audiences receive. `SELECT *` appears nowhere. A view
with no `agent` projection is unreachable by an agent; `link_prospects_uncontacted`
(contact PII) and `pending_approvals` (client identity) have none.

**3. A pure compiler and an auditing gateway.** `compileReportingQuery` is a
pure function: registry entries supply every identifier, caller input supplies
only bound values, and an unknown view, filter, order alias, or out-of-range
value is a rejection rather than a dropped clause. The gateway writes the audit
row BEFORE executing, so an unauditable query does not run, and executes inside
a read-only transaction with a per-audience `statement_timeout`.

**4. The credential chooses the audience.** `/api/reporting/*` accepts
`OPERATOR_API_KEY` (operator audience) or `REPORTING_AGENT_API_KEY` (agent
audience). The request body cannot select an audience. The agent surface is
opt-in: unset means agents have no access. Startup fails if the two secrets are
equal.

**5. Materialization is scheduler-owned.** Monthly spend, monthly citation rate,
and weekly keyword movements are materialized and refreshed CONCURRENTLY by
`reporting:refresh-materialized`, with per-view bookkeeping in
`reporting.refresh_log` and freshness exposed at
`GET /api/reporting/refresh-status`.

**6. Direct psql access is provisioned separately.**
`scripts/reporting/provision-roles.sql` creates three least-privilege login
roles with no `public` grant at all, a `search_path` that excludes `public`,
read-only transactions, and statement timeouts. Passwords are psql variables;
the migration creates no role and embeds no secret.

## Rationale
The alternative — a read-only role and a connection string — fails on the first
requirement. A role can be told not to write, but it cannot be told which
columns are appropriate for an LLM versus a human, cannot record why a query was
run, and cannot be given a per-view row cap. Column-level grants could
approximate the first of those, but they live in the database rather than in
reviewable, testable code, and they drift silently from the application that
depends on them.

Naming queries rather than accepting SQL also removes an entire class of failure
that has nothing to do with security: an LLM writing its own joins re-derives
"latest row per entity" every time, gets it subtly wrong, and answers a
portfolio question confidently and incorrectly. The views own that window logic
once.

Explicit projections rather than `SELECT *` cost more to maintain and are worth
it: a future column added to a view — a debugging field, a raw payload — would
otherwise reach the agent audience the moment it was created, with no diff to
review.

## Consequences
**Positive.** Credentials cannot leave through this plane. Every automated query
is auditable and rate-limited. The bot's own intelligence extractors consume the
same views the operator sees, so the dashboard and the bot cannot disagree about
what happened. Adding a question is a registry entry plus a test.

**Negative.** A question outside the registry requires a code change; the
gateway is deliberately not a general SQL endpoint. Materialized views are stale
between refreshes, which is why their age is part of the API response rather
than something a caller must infer. The seven new indexes cost write throughput
on the collection path — acceptable on a CX32-class host at current volumes, and
worth reviewing against `pg_stat_user_indexes` before adding more.

**Neutral.** `reporting` grows as a second surface to keep in step with schema
changes. `tests/reporting/plane-contract.test.ts` checks the registry, the
refresh list, and the migration against each other so drift fails in CI rather
than at runtime.

## Alternatives Considered
**A read-only Postgres role and a connection string.** Cheapest, and the reason
this ADR exists: it cannot express audience, cannot audit, and leaves
`posthog_api_key` one `SELECT *` away.

**Column-level GRANTs instead of view projections.** Enforced by the database,
which is genuinely stronger — but invisible in review, untestable without a live
database, and prone to drift from the code. The provisioning script uses
view-level grants so both mechanisms agree; the registry is the reviewable one.

**Widening the existing REST API instead.** Correct for a repeated, known
question, and the promotion path this ADR recommends. Wrong as the only option:
it forces a deploy for every exploratory question an operator has.

**Text-to-SQL against the live schema.** Rejected. It requires trusting a model
with schema access, produces non-reproducible queries, and cannot be rate-limited
or reviewed.

## Validation / Evidence
- `tests/reporting/query-compiler.test.ts` — injection attempts, audience
  isolation, deterministic compilation, registry-wide invariants.
- `tests/reporting/query-gateway.test.ts` — audit-before-execute (including that
  a failed audit write means no query ran), read-only transaction, per-audience
  timeout, and a round-trip of the compiled statement through the real Postgres
  dialect.
- `tests/reporting/plane-contract.test.ts` — registry, refresh list, and
  migration agree; no credential appears in the migration; every materialized
  view has the UNIQUE index CONCURRENTLY requires.
- `tests/api/reporting.test.ts` — the credential, not the request body, chooses
  the audience.
- `tests/core/config-reporting.test.ts` — startup fails when the two reporting
  secrets are equal.

## Related Artifacts
- `drizzle/0002_reporting_plane.sql`
- `src/reporting/`, `src/api/reporting.ts`
- `src/core/database/schema-reporting.ts`
- `scripts/reporting/provision-roles.sql`
- ADR-0002 (multi-tenant), ADR-0016 (intelligence plane, the primary consumer)

## Open Questions
- Whether `seo_benchmark_reporting` needs true k-anonymity thresholds on
  cross-client aggregates before any benchmark leaves the operator's own hands.
- Whether `reporting.query_audit_log` should be partitioned by month once
  automated consumers are live; it is append-only and unbounded today.
