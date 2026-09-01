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
 * ATTRIBUTION IS MEASURED, NOT ASSERTED.
 * The only claim made here is "the metric moved in this direction over this
 * window" - never "this action caused it". SEO has too many confounders for a
 * single-system before/after to establish causation, so `success` records an
 * observation and `learnings` records the window it was observed over. Writing
 * a causal claim into the feedback loop would let one coincidence teach the
 * scorer the wrong lesson permanently.
 *
 * A NULL METRIC IS NOT A FAILURE.
 * When the after-measurement is missing (the keyword fell out of the index,
 * the page has no traffic yet), attribution returns `null` rather than `false`.
 * Recording "no data" as "did not work" would systematically bias the loop
 * against actions on low-traffic pages, which are exactly the ones most likely
 * to need help.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { assertClientId } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:attribution");

/** Days to wait after an action before its effect is measurable. */
export const ATTRIBUTION_WINDOW_DAYS = 14;

export interface AttributionInput {
  keyword: string;
  positionBefore: number | null;
  positionAfter: number | null;
}

export interface AttributionResult {
  keyword: string;
  positionBefore: number | null;
  positionAfter: number | null;
  delta: number | null;
  /** true = improved, false = worsened, null = not measurable. */
  success: boolean | null;
  learnings: string;
}

/**
 * Compare a before/after ranking pair.
 *
 * Lower position numbers are better, so an improvement is a NEGATIVE delta.
 * This is the sign convention that gets inverted most often in ranking code, so
 * `delta` is defined once here (after - before) and every caller reads
 * `success` rather than re-deriving the comparison.
 */
export function attributeRankingChange(input: AttributionInput): AttributionResult {
  const { keyword, positionBefore, positionAfter } = input;

  if (positionBefore === null || positionAfter === null) {
    return {
      keyword,
      positionBefore,
      positionAfter,
      delta: null,
      success: null,
      learnings: "Not measurable: a before or after position was unavailable.",
    };
  }

  const delta = positionAfter - positionBefore;
  if (delta === 0) {
    return {
      keyword,
      positionBefore,
      positionAfter,
      delta,
      success: null,
      learnings: `No movement over ${ATTRIBUTION_WINDOW_DAYS} days (position ${positionAfter}).`,
    };
  }

  const improved = delta < 0;
  return {
    keyword,
    positionBefore,
    positionAfter,
    delta,
    success: improved,
    learnings:
      `Position moved ${positionBefore} -> ${positionAfter} ` +
      `(${improved ? "improved" : "worsened"} by ${Math.abs(delta)}) ` +
      `over ${ATTRIBUTION_WINDOW_DAYS} days. Correlation only; not a causal claim.`,
  };
}

/**
 * Attribute outcomes for one client's recently-routed keyword actions.
 *
 * Reads the current ranking for each keyword the loop acted on and records the
 * comparison in action_outcomes, the existing feedback table - rather than
 * inventing a second one, so the weekly report and any future scorer tuning
 * read from a single place.
 */
export async function attributeOutcomes(clientId: string): Promise<AttributionResult[]> {
  assertClientId(clientId);
  const db = getDb();

  const windowStart = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const signals = await db
    .select()
    .from(schema.intelligenceSignals)
    .where(
      and(
        eq(schema.intelligenceSignals.clientId, clientId),
        eq(schema.intelligenceSignals.signalType, "keyword_drop"),
        gte(schema.intelligenceSignals.firstSeenAt, windowStart),
      ),
    )
    .limit(200);

  if (signals.length === 0) return [];

  const rankings = await db
    .select()
    .from(schema.serpRankings)
    .where(eq(schema.serpRankings.clientId, clientId))
    .orderBy(desc(schema.serpRankings.checkedAt))
    .limit(500);

  const latestByKeyword = new Map<string, (typeof rankings)[number]>();
  for (const row of rankings) {
    if (!latestByKeyword.has(row.keyword)) latestByKeyword.set(row.keyword, row);
  }

  const results: AttributionResult[] = [];

  for (const signal of signals) {
    const evidence = (signal.evidence ?? {}) as Record<string, unknown>;
    const keyword = typeof evidence.keyword === "string" ? evidence.keyword : signal.entityKey;
    const before = typeof evidence.currentPosition === "number" ? evidence.currentPosition : null;
    const after = latestByKeyword.get(keyword)?.position ?? null;

    const result = attributeRankingChange({
      keyword,
      positionBefore: before,
      positionAfter: after,
    });
    results.push(result);

    await db.insert(schema.actionOutcomes).values({
      clientId,
      module: "intelligence",
      action: "intelligence_generate_surpass_plan",
      executedAt: signal.firstSeenAt,
      measuredAt: new Date(),
      positionBefore: result.positionBefore,
      positionAfter: result.positionAfter,
      success: result.success,
      learnings: result.learnings,
    });
  }

  logger.info(
    {
      clientId,
      measured: results.length,
      improved: results.filter((r) => r.success === true).length,
      unmeasurable: results.filter((r) => r.success === null).length,
    },
    "Outcome attribution complete",
  );

  return results;
}
