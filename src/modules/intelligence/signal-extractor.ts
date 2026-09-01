/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Signal Extraction
 *
 * Executes the named queries in ./queries and reports what they wrote.
 *
 * THE WORK HAPPENS IN THE DATABASE, NOT HERE.
 * Each extractor is one INSERT..SELECT..ON CONFLICT round trip. Nothing is read
 * into Node, filtered, and written back. That matters for three reasons:
 *
 *  - Idempotency is atomic. BullMQ is at-least-once, so these run twice on the
 *    same data routinely. A check-then-insert in Node is a race under
 *    concurrent fan-out; ON CONFLICT is not.
 *  - Tenant scoping is one bound parameter per statement, not a filter that a
 *    later refactor can drop from a chain of query-builder calls.
 *  - No N+1. The page-experience join in particular would otherwise be a
 *    cross-product assembled in memory.
 *
 * NO LLM MAY BE INTRODUCED IN THIS FILE. Extraction is the deterministic half
 * of the loop; the same rows must always produce the same signals, or the
 * scorer downstream is unreproducible and an operator cannot audit why a signal
 * fired.
 */

import { getDb } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import {
  assertClientId,
  budgetPressureQuery,
  citationLossQuery,
  failedJobsQuery,
  keywordDropsQuery,
  pageExperienceRisksQuery,
  prospectReadinessQuery,
  type SignalType,
} from "./queries/index.js";

const logger = createModuleLogger("intelligence:signals");

export type { SignalType } from "./queries/index.js";
export { assertClientId, PROSPECT_READY_STATUS, THRESHOLDS } from "./queries/index.js";

export type SignalSeverity = "low" | "medium" | "high" | "critical";

/** Shape returned when signals are read back out for scoring or packing. */
export interface ExtractedSignal {
  clientId: string;
  signalType: SignalType;
  entityType: string;
  entityKey: string;
  fingerprint: string;
  severity: SignalSeverity;
  confidence: number;
  evidence: Record<string, unknown>;
  status?: string;
  observedAt?: Date;
}

export interface ExtractionResult {
  /** Rows written per signal family — insert and update are indistinguishable
   *  through ON CONFLICT, which is the point: both mean "currently observed". */
  perFamily: Record<string, number>;
  total: number;
}

export interface ExtractSignalsOptions {
  /** Daily LLM spend cap, when configured. Budget pressure is skipped without one. */
  dailyCap?: number;
}

/**
 * Run every extractor for one client.
 *
 * Sequential rather than concurrent: they all write the same table, and running
 * them in parallel means several statements contending for the same unique
 * index for no wall-clock gain worth the lock pressure. A failure aborts the
 * run so intelligence_runs records a real error rather than a partial success
 * that looks complete.
 */
export async function extractSignals(
  clientId: string,
  runId: string,
  options: ExtractSignalsOptions = {},
): Promise<ExtractionResult> {
  assertClientId(clientId);
  const db = getDb();

  const perFamily: Record<string, number> = {};

  const families: Array<{ name: SignalType; run: () => Promise<number> }> = [
    { name: "keyword_drop", run: () => exec(keywordDropsQuery(clientId, runId)) },
    { name: "bad_lcp_high_exit", run: () => exec(pageExperienceRisksQuery(clientId, runId)) },
    { name: "citation_loss", run: () => exec(citationLossQuery(clientId, runId)) },
    { name: "prospect_ready", run: () => exec(prospectReadinessQuery(clientId, runId)) },
    { name: "job_failure_cluster", run: () => exec(failedJobsQuery(clientId, runId)) },
  ];

  // Budget pressure is only meaningful against a configured cap. Without one
  // there is no threshold to be near, so the family is skipped rather than
  // emitted with a meaningless denominator.
  if (typeof options.dailyCap === "number" && options.dailyCap > 0) {
    families.push({
      name: "llm_budget_pressure",
      run: () => exec(budgetPressureQuery(clientId, runId, options.dailyCap as number)),
    });
  }

  async function exec(statement: Parameters<typeof db.execute>[0]): Promise<number> {
    const result = (await db.execute(statement)) as unknown as { rowCount?: number | null };
    return result?.rowCount ?? 0;
  }

  let total = 0;
  for (const family of families) {
    const written = await family.run();
    perFamily[family.name] = written;
    total += written;
  }

  logger.info({ clientId, runId, total, perFamily }, "Signal extraction complete");
  return { perFamily, total };
}
