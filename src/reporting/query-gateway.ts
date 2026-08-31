/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Reporting Query Gateway (ADR-0015)
 *
 * Executes a compiled named query and audits it.
 *
 * Fail-closed audit: the audit row is written with status `started` BEFORE the
 * query runs. If that write fails, the query does not run — an unauditable
 * reporting query is not a reporting query. The outcome update afterwards is
 * best-effort and logged, because losing it degrades the record rather than
 * removing it.
 *
 * Every read runs inside a read-only transaction with a per-audience
 * `statement_timeout`, so neither a slow view nor a volatile function in a
 * future view can hold a connection open or write through this path.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { eq, type SQL, sql } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import {
  type CompiledReportingQuery,
  compileReportingQuery,
  type ReportingQueryRequest,
} from "./query-compiler.js";
import type { ReportingAudience } from "./views.js";

const logger = createModuleLogger("reporting:gateway");

/** Matches the per-role timeouts provisioned in scripts/reporting/provision-roles.sql. */
const STATEMENT_TIMEOUT_MS: Readonly<Record<ReportingAudience, number>> = {
  operator: 15_000,
  agent: 5_000,
};

export type ReportingActorType = "human" | "agent" | "api" | "system";

export interface ReportingActor {
  /** Stable, non-secret identifier for the caller (never a credential). */
  readonly id: string;
  readonly type: ReportingActorType;
  /** Where the request entered: "api:reporting", "scheduler", "cli". */
  readonly surface: string;
  readonly audience: ReportingAudience;
}

export interface ReportingQueryResult {
  readonly view: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly limit: number;
  readonly durationMs: number;
  readonly auditId: string;
}

/**
 * Rebuild a drizzle `SQL` object from the compiled `$n` text plus its params.
 *
 * The compiled text is the single source of truth: it is what gets hashed, what
 * gets audited, and what gets executed. Splitting on `$n` and interleaving the
 * bound values keeps those three identical by construction, rather than
 * building the statement twice and hoping the two agree.
 */
export function toDrizzleSql(compiled: CompiledReportingQuery): SQL {
  const parts = compiled.text.split(/\$(\d+)/);
  const chunks: SQL[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index % 2 === 0) {
      if (part !== "") chunks.push(sql.raw(part));
      continue;
    }
    const paramIndex = Number(part) - 1;
    if (paramIndex < 0 || paramIndex >= compiled.params.length) {
      throw new Error(
        `Compiled reporting query references $${part} but only ${compiled.params.length} parameter(s) were bound`,
      );
    }
    chunks.push(sql`${compiled.params[paramIndex]}`);
  }

  return sql.join(chunks, sql.raw(""));
}

async function insertAuditRow(
  actor: ReportingActor,
  compiled: CompiledReportingQuery,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.reportingQueryAuditLog)
    .values({
      actor: actor.id,
      actorType: actor.type,
      surface: actor.surface,
      queryName: compiled.view,
      sqlHash: compiled.sqlHash,
      parameters: compiled.appliedFilters,
      status: "started",
    })
    .returning({ id: schema.reportingQueryAuditLog.id });
  return row.id;
}

async function finalizeAuditRow(
  auditId: string,
  outcome: { status: string; rowCount?: number; durationMs: number; error?: string },
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(schema.reportingQueryAuditLog)
      .set({
        status: outcome.status,
        rowCount: outcome.rowCount ?? null,
        durationMs: outcome.durationMs,
        error: outcome.error ?? null,
      })
      .where(eq(schema.reportingQueryAuditLog.id, auditId));
  } catch (error) {
    // The query already ran and was recorded as `started`; losing the outcome
    // degrades the audit trail but must not turn a successful read into a 500.
    logger.error(
      { auditId, err: error instanceof Error ? error.message : String(error) },
      "Failed to finalize reporting query audit row",
    );
  }
}

/**
 * Compile, audit, and execute a named reporting query.
 *
 * @throws {ReportingQueryError} when the request is not permitted by the registry.
 */
export async function executeReportingQuery(
  request: ReportingQueryRequest,
  actor: ReportingActor,
): Promise<ReportingQueryResult> {
  const compiled = compileReportingQuery(request, actor.audience);

  // Fail closed: no audit row, no query.
  const auditId = await insertAuditRow(actor, compiled);

  const startedAt = Date.now();
  try {
    const db = getDb();
    const timeoutMs = STATEMENT_TIMEOUT_MS[actor.audience];
    const rows = await db.transaction(async (tx) => {
      // SET LOCAL scopes both to this transaction. The timeout value is a
      // module constant keyed by audience, never caller input.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`));
      await tx.execute(sql.raw("SET LOCAL transaction_read_only = on"));
      const result = await tx.execute(toDrizzleSql(compiled));
      return (result as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
    });

    const durationMs = Date.now() - startedAt;
    await finalizeAuditRow(auditId, { status: "ok", rowCount: rows.length, durationMs });

    logger.info(
      { view: compiled.view, actorType: actor.type, rowCount: rows.length, durationMs },
      "Reporting query executed",
    );

    return {
      view: compiled.view,
      columns: compiled.columns,
      rows,
      rowCount: rows.length,
      // The caller cannot tell a full page from an exhausted result set without
      // this; a silently-clipped answer is how a portfolio question gets a
      // confidently wrong answer.
      truncated: rows.length === compiled.limit,
      limit: compiled.limit,
      durationMs,
      auditId,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    await finalizeAuditRow(auditId, { status: "error", durationMs, error: message });
    logger.error({ view: compiled.view, err: message }, "Reporting query failed");
    throw error;
  }
}
