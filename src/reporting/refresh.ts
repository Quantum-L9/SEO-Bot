/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Materialized Reporting Refresh (ADR-0015)
 *
 * Refresh is owned by the app scheduler, never by an ad-hoc operator or agent
 * session: a REFRESH holds locks and burns I/O, and letting arbitrary sessions
 * trigger it is how a reporting plane becomes an availability problem for the
 * bot it reports on.
 *
 * CONCURRENTLY keeps the old snapshot readable during the rebuild. It requires a
 * UNIQUE index, which migration 0002 creates on every view listed here. A view
 * without one would fail at refresh time, so the list below is closed and
 * matched by a test against the migration.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";

const logger = createModuleLogger("reporting:refresh");

/**
 * The materialized views under scheduler ownership, in refresh order.
 * Identifiers are repository constants — never caller input.
 */
export const MATERIALIZED_VIEWS: readonly string[] = [
  "reporting.mv_llm_spend_monthly",
  "reporting.mv_aeo_citation_rate_monthly",
  "reporting.mv_weekly_keyword_movements",
] as const;

const SAFE_MATERIALIZED_VIEW = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export interface RefreshOutcome {
  readonly viewName: string;
  readonly status: "ok" | "error";
  readonly durationMs: number;
  readonly error?: string;
}

/** Quote a `schema.view` constant for use in DDL. */
export function quoteMaterializedView(viewName: string): string {
  if (!SAFE_MATERIALIZED_VIEW.test(viewName)) {
    throw new Error(`Refusing to refresh unsafe materialized view name: "${viewName}"`);
  }
  const [schemaName, relationName] = viewName.split(".");
  return `"${schemaName}"."${relationName}"`;
}

async function recordRefresh(outcome: RefreshOutcome): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.reportingRefreshLog)
    .values({
      viewName: outcome.viewName,
      refreshedAt: new Date(),
      durationMs: outcome.durationMs,
      status: outcome.status,
      error: outcome.error ?? null,
    })
    .onConflictDoUpdate({
      target: schema.reportingRefreshLog.viewName,
      set: {
        refreshedAt: new Date(),
        durationMs: outcome.durationMs,
        status: outcome.status,
        error: outcome.error ?? null,
      },
    });
}

/**
 * Refresh every scheduler-owned materialized view.
 *
 * One failing view does not stop the rest: each is independent, and a partial
 * refresh with an honest `refresh_log` beats an all-or-nothing abort that leaves
 * the operator unable to tell which snapshot is stale.
 */
export async function refreshMaterializedViews(
  viewNames: readonly string[] = MATERIALIZED_VIEWS,
): Promise<RefreshOutcome[]> {
  const db = getDb();
  const outcomes: RefreshOutcome[] = [];

  for (const viewName of viewNames) {
    const quoted = quoteMaterializedView(viewName);
    const startedAt = Date.now();
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${quoted}`));
      const outcome: RefreshOutcome = {
        viewName,
        status: "ok",
        durationMs: Date.now() - startedAt,
      };
      outcomes.push(outcome);
      await recordRefresh(outcome);
      logger.info({ viewName, durationMs: outcome.durationMs }, "Materialized view refreshed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome: RefreshOutcome = {
        viewName,
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      };
      outcomes.push(outcome);
      await recordRefresh(outcome).catch((recordError: unknown) => {
        logger.error(
          { viewName, err: String(recordError) },
          "Failed to record materialized view refresh failure",
        );
      });
      logger.error({ viewName, err: message }, "Materialized view refresh failed");
    }
  }

  return outcomes;
}

export interface RefreshStatusRow {
  readonly viewName: string;
  readonly refreshedAt: Date;
  readonly durationMs: number | null;
  readonly status: string;
  readonly error: string | null;
  readonly ageSeconds: number;
}

/**
 * Current freshness of every materialized view, newest first. A view that has
 * never refreshed simply has no row — reported as absent rather than as fresh.
 */
export async function getRefreshStatus(): Promise<RefreshStatusRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.reportingRefreshLog)
    .orderBy(desc(schema.reportingRefreshLog.refreshedAt));
  const now = Date.now();
  return rows.map((row) => ({
    viewName: row.viewName,
    refreshedAt: row.refreshedAt,
    durationMs: row.durationMs,
    status: row.status,
    error: row.error,
    ageSeconds: Math.max(0, Math.round((now - row.refreshedAt.getTime()) / 1000)),
  }));
}
