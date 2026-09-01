/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Outcome Attribution
 *
 * Closes the loop: for each routed action, did the thing it targeted improve?
 *
 * THE WINDOW IS FIXED BEFORE THE RESULT IS KNOWN.
 * An experiment row records its baseline and measurement periods when the
 * action is routed, not when it is measured. That ordering is the whole point:
 * if the window were chosen at measurement time, the loop could always find a
 * span that made an action look good, and its own scoring feedback would be
 * quietly self-confirming.
 *
 * SEO MOVES SLOWLY, SO ONE WINDOW IS NOT ENOUGH.
 *   0-7 days    early movement only, never a verdict
 *   7-21 days   the primary measurement
 *   21-45 days  final attribution for slower categories
 * Reporting a 3-day result as final is how you conclude that a content refresh
 * "failed" before Google has recrawled the page.
 *
 * ATTRIBUTION IS MEASURED, NOT ASSERTED. The only claim made is "the metric
 * moved in this direction over this window" — never "this action caused it".
 * SEO has too many confounders for a single-system before/after to establish
 * causation, and writing a causal claim into the feedback loop would let one
 * coincidence teach the scorer a permanent wrong lesson.
 *
 * A NULL METRIC IS NOT A FAILURE. When the after-measurement is missing (the
 * keyword left the tracked set, the page has no traffic yet) attribution
 * returns null, not false. Recording "no data" as "did not work" would bias the
 * loop against low-traffic pages — exactly the ones most likely to need help.
 */

import { createModuleLogger } from "../../core/logger.js";

const logger = createModuleLogger("intelligence:attribution");

/** Measurement phases, in days after the action executed. */
export const ATTRIBUTION_WINDOWS = {
  early: { start: 0, end: 7 },
  primary: { start: 7, end: 21 },
  final: { start: 21, end: 45 },
} as const;

export type AttributionPhase = keyof typeof ATTRIBUTION_WINDOWS;

/** Days of history before the action that form the baseline. */
export const BASELINE_DAYS = 14;

export interface AttributionWindow {
  baselineStart: Date;
  baselineEnd: Date;
  measurementStart: Date;
  measurementEnd: Date;
}

/**
 * Compute the fixed window for a phase, from the moment the action executed.
 * Pure and exported so the router can persist it up front and the measurer can
 * recompute the identical span later.
 */
export function windowFor(executedAt: Date, phase: AttributionPhase): AttributionWindow {
  const day = 24 * 60 * 60 * 1000;
  const { start, end } = ATTRIBUTION_WINDOWS[phase];
  return {
    baselineStart: new Date(executedAt.getTime() - BASELINE_DAYS * day),
    baselineEnd: new Date(executedAt.getTime()),
    measurementStart: new Date(executedAt.getTime() + start * day),
    measurementEnd: new Date(executedAt.getTime() + end * day),
  };
}

/** Which phase, if any, is ready to be measured for an action executed then. */
export function readyPhase(executedAt: Date, now: Date = new Date()): AttributionPhase | null {
  const ageDays = (now.getTime() - executedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays >= ATTRIBUTION_WINDOWS.final.end) return "final";
  if (ageDays >= ATTRIBUTION_WINDOWS.primary.end) return "primary";
  if (ageDays >= ATTRIBUTION_WINDOWS.early.end) return "early";
  return null;
}

export interface AttributionInput {
  keyword: string;
  positionBefore: number | null;
  positionAfter: number | null;
  trafficBefore?: number | null;
  trafficAfter?: number | null;
  phase: AttributionPhase;
}

export interface AttributionResult {
  keyword: string;
  phase: AttributionPhase;
  positionBefore: number | null;
  positionAfter: number | null;
  trafficBefore: number | null;
  trafficAfter: number | null;
  delta: number | null;
  /** true = improved, false = worsened, null = not measurable or not yet final. */
  success: boolean | null;
  learnings: string;
}

/**
 * Compare a before/after ranking pair for one phase.
 *
 * Lower position numbers are better, so an improvement is a NEGATIVE delta.
 * That sign convention is the most commonly inverted comparison in ranking
 * code, so `delta` is defined once here (after - before) and callers read
 * `success` rather than re-deriving it.
 *
 * The `early` phase never returns a verdict, only an observation: seven days is
 * not enough for a ranking change to settle, and letting it set `success` would
 * feed noise straight into scoring.
 */
export function attributeRankingChange(input: AttributionInput): AttributionResult {
  const { keyword, positionBefore, positionAfter, phase } = input;
  const trafficBefore = input.trafficBefore ?? null;
  const trafficAfter = input.trafficAfter ?? null;

  const base = {
    keyword,
    phase,
    positionBefore,
    positionAfter,
    trafficBefore,
    trafficAfter,
  };

  if (positionBefore === null || positionAfter === null) {
    return {
      ...base,
      delta: null,
      success: null,
      learnings: "Not measurable: a before or after position was unavailable.",
    };
  }

  const delta = positionAfter - positionBefore;
  const windowLabel = `${ATTRIBUTION_WINDOWS[phase].start}-${ATTRIBUTION_WINDOWS[phase].end}d`;

  if (phase === "early") {
    return {
      ...base,
      delta,
      success: null,
      learnings:
        `Early movement over ${windowLabel}: position ${positionBefore} -> ${positionAfter} ` +
        `(delta ${delta}). Too soon for a verdict; recorded as observation only.`,
    };
  }

  if (delta === 0) {
    return {
      ...base,
      delta,
      success: null,
      learnings: `No movement over ${windowLabel} (position ${positionAfter}).`,
    };
  }

  const improved = delta < 0;
  return {
    ...base,
    delta,
    success: improved,
    learnings:
      `Position moved ${positionBefore} -> ${positionAfter} ` +
      `(${improved ? "improved" : "worsened"} by ${Math.abs(delta)}) over ${windowLabel}. ` +
      `Correlation only; not a causal claim.`,
  };
}

export function summarizeAttribution(results: AttributionResult[]): Record<string, number> {
  const summary = {
    measured: results.length,
    improved: results.filter((r) => r.success === true).length,
    worsened: results.filter((r) => r.success === false).length,
    inconclusive: results.filter((r) => r.success === null).length,
  };
  logger.debug(summary, "Attribution summary");
  return summary;
}
