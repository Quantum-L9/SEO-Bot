/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Outcome Attributor (ADR-0016)
 *
 * The Measure→Learn half of the loop, and the half that actually makes the bot
 * self-improving rather than merely busy.
 *
 * An SEO change has no observable effect at the moment it ships. It has a
 * baseline window before and a measurement window after, and "did it work?" is
 * only a real question once both windows have closed. So every executed action
 * opens an experiment, and a separate scheduled pass measures the ones whose
 * window has ended.
 *
 * Results land on the EXISTING `action_outcomes` row (measuredAt / success /
 * learnings). That is not incidental: `src/services/memory.ts` already promotes
 * exactly those rows into governed cross-agent memory, so writing them here
 * closes the loop through the pipeline that exists instead of building a second
 * one beside it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import { applyVerdictToOpportunity, type OpportunityStatus } from "./lifecycle.js";
import { asNumber } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:attribution");

export type TargetMetric = "serp_position" | "page_exit_rate" | "aeo_citation_rate";

export interface WindowSpec {
  readonly baselineStart: Date;
  readonly baselineEnd: Date;
  readonly measurementStart: Date;
  readonly measurementEnd: Date;
}

const DAY_MS = 86_400_000;

/**
 * Windows around an execution instant: `baselineDays` before, `measurementDays`
 * after. The baseline ends AT execution — including the change's own day in the
 * baseline is how a fix gets credited with the damage it repaired.
 */
export function buildWindows(
  executedAt: Date,
  baselineDays: number,
  measurementDays: number,
): WindowSpec {
  const executedMs = executedAt.getTime();
  return {
    baselineStart: new Date(executedMs - baselineDays * DAY_MS),
    baselineEnd: executedAt,
    measurementStart: executedAt,
    measurementEnd: new Date(executedMs + measurementDays * DAY_MS),
  };
}

export interface MetricComparison {
  readonly baseline: number | null;
  readonly measured: number | null;
  readonly delta: number | null;
  readonly sampleCountBaseline: number;
  readonly sampleCountMeasured: number;
}

export type ExperimentVerdict = "improved" | "declined" | "unchanged" | "inconclusive";

/**
 * Judge a comparison.
 *
 * `lowerIsBetter` is true for SERP position and exit rate (position 3 beats
 * position 9) and false for citation rate. Thin samples return `inconclusive`
 * rather than a verdict — recording "it worked" off two data points would poison
 * the memory the next cycle reasons from, which is worse than recording nothing.
 */
export function judgeComparison(
  comparison: MetricComparison,
  options: { lowerIsBetter: boolean; minSamples: number; minRelativeChange: number },
): ExperimentVerdict {
  const { baseline, measured } = comparison;
  if (baseline === null || measured === null) return "inconclusive";
  if (
    comparison.sampleCountBaseline < options.minSamples ||
    comparison.sampleCountMeasured < options.minSamples
  ) {
    return "inconclusive";
  }
  if (baseline === 0) return measured === 0 ? "unchanged" : "inconclusive";

  const relative = (measured - baseline) / Math.abs(baseline);
  if (Math.abs(relative) < options.minRelativeChange) return "unchanged";

  const improved = options.lowerIsBetter ? relative < 0 : relative > 0;
  return improved ? "improved" : "declined";
}

const METRIC_RULES: Readonly<
  Record<TargetMetric, { lowerIsBetter: boolean; minSamples: number; minRelativeChange: number }>
> = {
  serp_position: { lowerIsBetter: true, minSamples: 3, minRelativeChange: 0.05 },
  page_exit_rate: { lowerIsBetter: true, minSamples: 2, minRelativeChange: 0.05 },
  aeo_citation_rate: { lowerIsBetter: false, minSamples: 3, minRelativeChange: 0.1 },
};

/** Human-readable learning, written to `action_outcomes.learnings`. */
export function summarizeExperiment(input: {
  hypothesis: string;
  targetMetric: TargetMetric;
  entityId: string;
  verdict: ExperimentVerdict;
  comparison: MetricComparison;
}): string {
  const { baseline, measured, delta } = input.comparison;
  const deltaText = delta === null ? "n/a" : round(delta);
  const numbers =
    baseline !== null && measured !== null
      ? `${round(baseline)} → ${round(measured)} (Δ ${deltaText})`
      : "insufficient data";

  switch (input.verdict) {
    case "improved":
      return `CONFIRMED: ${input.hypothesis} ${input.targetMetric} on ${input.entityId} improved: ${numbers}.`;
    case "declined":
      return `REFUTED: ${input.hypothesis} ${input.targetMetric} on ${input.entityId} moved the wrong way: ${numbers}. Do not repeat this remedy for the same symptom without a different rationale.`;
    case "unchanged":
      return `NO EFFECT: ${input.hypothesis} ${input.targetMetric} on ${input.entityId} was flat: ${numbers}. The remedy is not the lever for this symptom.`;
    default:
      return `INCONCLUSIVE: ${input.targetMetric} on ${input.entityId} had too little data to judge (${numbers}). No learning recorded.`;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ─── Measurement queries ─────────────────────────────────────────────────────

async function compareMetric(
  metric: TargetMetric,
  clientId: string,
  entityId: string,
  windows: WindowSpec,
): Promise<MetricComparison> {
  const db = getDb();

  const expression = {
    serp_position: sql`
      SELECT
        avg(position) FILTER (WHERE checked_at >= ${windows.baselineStart} AND checked_at < ${windows.baselineEnd}) AS baseline,
        count(*)      FILTER (WHERE checked_at >= ${windows.baselineStart} AND checked_at < ${windows.baselineEnd}) AS baseline_samples,
        avg(position) FILTER (WHERE checked_at >= ${windows.measurementStart} AND checked_at <= ${windows.measurementEnd}) AS measured,
        count(*)      FILTER (WHERE checked_at >= ${windows.measurementStart} AND checked_at <= ${windows.measurementEnd}) AS measured_samples
      FROM serp_rankings
      WHERE client_id = ${clientId}::uuid AND keyword = ${entityId} AND position IS NOT NULL
    `,
    page_exit_rate: sql`
      SELECT
        avg(exit_rate) FILTER (WHERE computed_at >= ${windows.baselineStart} AND computed_at < ${windows.baselineEnd}) AS baseline,
        count(*)       FILTER (WHERE computed_at >= ${windows.baselineStart} AND computed_at < ${windows.baselineEnd}) AS baseline_samples,
        avg(exit_rate) FILTER (WHERE computed_at >= ${windows.measurementStart} AND computed_at <= ${windows.measurementEnd}) AS measured,
        count(*)       FILTER (WHERE computed_at >= ${windows.measurementStart} AND computed_at <= ${windows.measurementEnd}) AS measured_samples
      FROM page_engagement
      WHERE client_id = ${clientId}::uuid AND page_path = ${entityId} AND exit_rate IS NOT NULL
    `,
    aeo_citation_rate: sql`
      SELECT
        100.0 * count(*) FILTER (WHERE cited AND checked_at >= ${windows.baselineStart} AND checked_at < ${windows.baselineEnd})
              / NULLIF(count(*) FILTER (WHERE checked_at >= ${windows.baselineStart} AND checked_at < ${windows.baselineEnd}), 0) AS baseline,
        count(*) FILTER (WHERE checked_at >= ${windows.baselineStart} AND checked_at < ${windows.baselineEnd}) AS baseline_samples,
        100.0 * count(*) FILTER (WHERE cited AND checked_at >= ${windows.measurementStart} AND checked_at <= ${windows.measurementEnd})
              / NULLIF(count(*) FILTER (WHERE checked_at >= ${windows.measurementStart} AND checked_at <= ${windows.measurementEnd}), 0) AS measured,
        count(*) FILTER (WHERE checked_at >= ${windows.measurementStart} AND checked_at <= ${windows.measurementEnd}) AS measured_samples
      FROM aeo_citations
      WHERE client_id = ${clientId}::uuid AND platform = ${entityId}
    `,
  }[metric];

  const result = await db.execute(expression);
  const row = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0] ?? {};

  const baseline = asNumber(row.baseline);
  const measured = asNumber(row.measured);
  return {
    baseline,
    measured,
    delta: baseline !== null && measured !== null ? measured - baseline : null,
    sampleCountBaseline: asNumber(row.baseline_samples) ?? 0,
    sampleCountMeasured: asNumber(row.measured_samples) ?? 0,
  };
}

// ─── Experiment lifecycle ────────────────────────────────────────────────────

export interface OpenExperimentInput {
  readonly clientId: string;
  readonly decisionId: string | null;
  readonly actionOutcomeId: string | null;
  readonly hypothesis: string;
  readonly targetMetric: TargetMetric;
  readonly entityType: string;
  readonly entityId: string;
  readonly executedAt: Date;
  readonly baselineDays: number;
  readonly measurementDays: number;
}

/** Open the attribution window for an action that has just been executed. */
export async function openExperiment(input: OpenExperimentInput): Promise<string> {
  const db = getDb();
  const windows = buildWindows(input.executedAt, input.baselineDays, input.measurementDays);

  const [row] = await db
    .insert(schema.intelligenceExperiments)
    .values({
      clientId: input.clientId,
      decisionId: input.decisionId,
      actionOutcomeId: input.actionOutcomeId,
      hypothesis: input.hypothesis,
      targetMetric: input.targetMetric,
      entityType: input.entityType,
      entityId: input.entityId,
      baselineStart: windows.baselineStart,
      baselineEnd: windows.baselineEnd,
      measurementStart: windows.measurementStart,
      measurementEnd: windows.measurementEnd,
      status: "measuring",
    })
    .returning({ id: schema.intelligenceExperiments.id });

  logger.info(
    {
      experimentId: row.id,
      clientId: input.clientId,
      metric: input.targetMetric,
      measurementEnd: windows.measurementEnd.toISOString(),
    },
    "Attribution window opened",
  );
  return row.id;
}

export interface MeasuredExperiment {
  readonly experimentId: string;
  readonly verdict: ExperimentVerdict;
  readonly comparison: MetricComparison;
  readonly learnings: string;
  /**
   * Status the opportunity behind this experiment moved to, or null when there
   * was nothing to move (no linked decision, an inconclusive verdict, or an
   * opportunity already in a terminal state).
   */
  readonly opportunityStatus: OpportunityStatus | null;
}

/**
 * Measure every experiment whose window has closed.
 *
 * One failure does not abort the pass: an experiment that cannot be measured is
 * marked `error` and left behind honestly, rather than blocking the ones that can.
 */
export async function measureDueExperiments(now: Date = new Date()): Promise<MeasuredExperiment[]> {
  const db = getDb();

  const due = await db
    .select()
    .from(schema.intelligenceExperiments)
    .where(
      and(
        eq(schema.intelligenceExperiments.status, "measuring"),
        lte(schema.intelligenceExperiments.measurementEnd, now),
      ),
    )
    .limit(100);

  const measured: MeasuredExperiment[] = [];

  for (const experiment of due) {
    try {
      const metric = experiment.targetMetric as TargetMetric;
      const rules = METRIC_RULES[metric];
      if (!rules) throw new Error(`Unknown target metric "${experiment.targetMetric}"`);

      const comparison = await compareMetric(metric, experiment.clientId, experiment.entityId, {
        baselineStart: experiment.baselineStart,
        baselineEnd: experiment.baselineEnd,
        measurementStart: experiment.measurementStart,
        measurementEnd: experiment.measurementEnd,
      });

      const verdict = judgeComparison(comparison, rules);
      const learnings = summarizeExperiment({
        hypothesis: experiment.hypothesis,
        targetMetric: metric,
        entityId: experiment.entityId,
        verdict,
        comparison,
      });

      await db
        .update(schema.intelligenceExperiments)
        .set({
          status: verdict === "inconclusive" ? "inconclusive" : "measured",
          result: { verdict, comparison, learnings },
        })
        .where(eq(schema.intelligenceExperiments.id, experiment.id));

      // Feed the existing outcome row so the existing memory promoter picks it
      // up. Only a decisive verdict is promoted: `success` is a claim, and an
      // inconclusive measurement does not support one.
      if (experiment.actionOutcomeId && verdict !== "inconclusive") {
        await db
          .update(schema.actionOutcomes)
          .set({
            measuredAt: now,
            success: verdict === "improved",
            learnings,
          })
          .where(
            and(
              eq(schema.actionOutcomes.id, experiment.actionOutcomeId),
              isNull(schema.actionOutcomes.measuredAt),
            ),
          );
      }

      // Close the loop on the opportunity itself (contract C3). `improved`
      // resolves it; `declined` and `unchanged` reopen it, because a remedy that
      // did not work leaves the problem in place and the next cycle has to be
      // allowed to see it again. A failure here is logged, not thrown: the
      // measurement is already recorded and losing the transition must not undo
      // it or abort the remaining experiments.
      const transition = await applyVerdictToOpportunity(experiment.decisionId, verdict).catch(
        (error: unknown) => {
          logger.error(
            {
              experimentId: experiment.id,
              err: error instanceof Error ? error.message : String(error),
            },
            "Opportunity transition failed after a successful measurement",
          );
          return null;
        },
      );

      measured.push({
        experimentId: experiment.id,
        verdict,
        comparison,
        learnings,
        opportunityStatus: transition?.status ?? null,
      });
      logger.info(
        { experimentId: experiment.id, metric, verdict, opportunityStatus: transition?.status },
        "Attribution window measured",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ experimentId: experiment.id, err: message }, "Experiment measurement failed");
      await db
        .update(schema.intelligenceExperiments)
        .set({ status: "error", result: { error: message } })
        .where(eq(schema.intelligenceExperiments.id, experiment.id))
        .catch(() => undefined);
    }
  }

  return measured;
}
