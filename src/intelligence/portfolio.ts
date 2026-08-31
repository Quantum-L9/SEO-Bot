/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Portfolio Benchmark Run (ADR-0015 contract C1, ADR-0016)
 *
 * Every other run type in this plane is scoped to one client. This one is not,
 * and that is the point: "is a 40% citation rate good for a legal client in NC?"
 * cannot be answered from inside one tenant's data.
 *
 * The run records a snapshot of the benchmark plane rather than computing it —
 * the arithmetic lives in the materialized view (migration 0004), under the
 * k-anonymity floor. What this adds is the durable record: how many cohorts were
 * publishable this week, how many existed but were suppressed, and how many
 * clients contributed. Without that record an operator finding an empty
 * benchmark cannot tell "the floor suppressed everything" from "the pipeline is
 * broken", and on a small portfolio the first is much the more likely.
 *
 * `clientId` is null on the run row, which is what `intelligence_runs` already
 * documents as "portfolio-wide, not scoped to one tenant".
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { sql } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import { BENCHMARK_K_ANONYMITY_FLOOR } from "../reporting/views.js";
import { asNumber } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:portfolio");

/** The run type recorded on `intelligence_runs.run_type` for this pass. */
export const PORTFOLIO_BENCHMARK_RUN_TYPE = "weekly_portfolio_benchmark";

export interface PortfolioBenchmarkSummary {
  readonly runId: string;
  /** Cohorts that cleared the anonymity floor and are therefore readable. */
  readonly publishedCohorts: number;
  /** Cohorts that exist but are below the floor. A count of cohorts, never of clients. */
  readonly suppressedCohorts: number;
  /** Distinct periods (months) represented in the published set. */
  readonly periods: number;
  readonly anonymityFloor: number;
}

interface CoverageRow {
  readonly published: unknown;
  readonly suppressed: unknown;
  readonly periods: unknown;
}

/**
 * Count what the benchmark plane can and cannot say this week.
 *
 * Read from the COVERAGE view, not by re-deriving cohorts here: the coverage
 * view applies the same floor as the benchmark view, from the same per-client
 * rollup, so the two cannot drift into disagreeing about which cohorts exist.
 * A second implementation of "what counts as a cohort" is exactly how a privacy
 * floor ends up enforced in one place and not the other.
 */
async function readCoverage(): Promise<PortfolioCoverageCounts> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE meets_anonymity_floor)     AS published,
      count(*) FILTER (WHERE NOT meets_anonymity_floor) AS suppressed,
      count(DISTINCT period) FILTER (WHERE meets_anonymity_floor) AS periods
    FROM reporting.mv_portfolio_cohort_coverage
  `);
  const row = (((result as unknown as { rows: CoverageRow[] }).rows ?? [])[0] ?? {}) as CoverageRow;
  return {
    published: asNumber(row.published) ?? 0,
    suppressed: asNumber(row.suppressed) ?? 0,
    periods: asNumber(row.periods) ?? 0,
  };
}

interface PortfolioCoverageCounts {
  readonly published: number;
  readonly suppressed: number;
  readonly periods: number;
}

/**
 * Record one portfolio benchmark pass.
 *
 * Failure is recorded on the run row and rethrown, matching `runClientTriage`:
 * a benchmark that silently produced nothing is indistinguishable from one that
 * legitimately had nothing to publish, and the scheduler's `job_executions` row
 * is what the `job_failure_cluster` extractor watches.
 */
export async function runPortfolioBenchmark(
  triggerSource: "cron" | "manual" | "api" = "cron",
): Promise<PortfolioBenchmarkSummary> {
  const db = getDb();
  const startedAt = Date.now();

  const [runRow] = await db
    .insert(schema.intelligenceRuns)
    .values({
      // Null: this run belongs to the portfolio, not to a tenant.
      clientId: null,
      runType: PORTFOLIO_BENCHMARK_RUN_TYPE,
      triggerSource,
      status: "running",
      llmUsed: false,
    })
    .returning({ id: schema.intelligenceRuns.id });
  const runId = runRow.id;

  try {
    const coverage = await readCoverage();

    const summary: PortfolioBenchmarkSummary = {
      runId,
      publishedCohorts: coverage.published,
      suppressedCohorts: coverage.suppressed,
      periods: coverage.periods,
      anonymityFloor: BENCHMARK_K_ANONYMITY_FLOOR,
    };

    await db
      .update(schema.intelligenceRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        metadata: {
          published_cohorts: summary.publishedCohorts,
          suppressed_cohorts: summary.suppressedCohorts,
          periods: summary.periods,
          anonymity_floor: summary.anonymityFloor,
        },
      })
      .where(sql`${schema.intelligenceRuns.id} = ${runId}::uuid`);

    if (summary.publishedCohorts === 0 && summary.suppressedCohorts > 0) {
      // The normal state of a small portfolio, and worth saying plainly so
      // nobody spends an afternoon debugging a working privacy control.
      logger.info(
        { runId, suppressedCohorts: summary.suppressedCohorts, floor: summary.anonymityFloor },
        "No cohort reached the anonymity floor — benchmarks are empty by design, not by failure",
      );
    } else {
      logger.info(summary, "Portfolio benchmark run completed");
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.intelligenceRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        error: message,
      })
      .where(sql`${schema.intelligenceRuns.id} = ${runId}::uuid`)
      .catch(() => undefined);
    logger.error({ runId, err: message }, "Portfolio benchmark run failed");
    throw error;
  }
}
