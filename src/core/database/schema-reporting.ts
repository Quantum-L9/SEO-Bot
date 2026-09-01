/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Reporting Plane Schema (ADR-0015)
 *
 * The `reporting` schema is a READ contract: curated views over the operational
 * tables, carrying no secrets and no unbounded joins. Drizzle only models the
 * two tables the application itself WRITES:
 *
 *   - reporting.refresh_log      — materialized-view refresh bookkeeping
 *   - reporting.query_audit_log  — every gateway query, audited before it runs
 *
 * The views themselves are deliberately NOT modelled as Drizzle tables. They are
 * a SQL contract owned by migration 0002 and reached through the named-query
 * registry in `src/reporting/views.ts`; modelling them here would invite ad-hoc
 * query construction against them and defeat the allow-list.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { index, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** The governed read schema. Created by migration 0002. */
export const reportingPgSchema = pgSchema("reporting");

/** One row per materialized view; upserted by the refresh job. */
export const reportingRefreshLog = reportingPgSchema.table("refresh_log", {
  viewName: text("view_name").primaryKey(),
  refreshedAt: timestamp("refreshed_at").notNull().defaultNow(),
  durationMs: integer("duration_ms"),
  status: text("status").notNull(),
  error: text("error"),
});

/**
 * Query audit. A row is inserted with status `started` BEFORE the query runs and
 * updated with the outcome afterwards, so a query that cannot be audited never
 * executes (fail-closed). `parameters` holds validated filter values only —
 * never raw operator input, never credentials.
 */
export const reportingQueryAuditLog = reportingPgSchema.table(
  "query_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor").notNull(),
    /** 'human' | 'agent' | 'api' | 'system' — CHECK-constrained in migration 0002. */
    actorType: text("actor_type").notNull(),
    surface: text("surface").notNull(),
    queryName: text("query_name"),
    sqlHash: text("sql_hash"),
    parameters: jsonb("parameters").notNull().default({}),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index("idx_query_audit_created").on(table.createdAt),
    actorIdx: index("idx_query_audit_actor").on(table.actorType, table.createdAt),
  }),
);
