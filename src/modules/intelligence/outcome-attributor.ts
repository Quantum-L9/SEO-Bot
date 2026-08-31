/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: outcome attribution
 *
 * Closes the loop: after a routed action has had time to take effect, compare
 * what the signal measured then against what the producer tables say now, and
 * record the delta on `action_outcomes`.
 *
 * The honesty rules here matter more than the arithmetic:
 *
 *  - ATTRIBUTION IS NOT CAUSATION. A ranking that recovered after a surpass
 *    plan was generated may have recovered for reasons of its own. What is
 *    recorded is an observed delta over a window, and `learnings` says so.
 *
 *  - AN UNMEASURABLE OUTCOME IS RECORDED AS UNKNOWN, never as a success.
 *    `success` stays null when there is no post-action reading, because a
 *    missing measurement scored as a win would teach the loop that doing
 *    nothing works.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { assertClientId } from "./policy-gate.js";

const logger = createModuleLogger("intelligence:outcomes");

/** How long an action is given before its effect is judged. */
const MATURATION_DAYS = 7;

/** How long after maturation an action is still worth measuring. */
const MAX_AGE_DAYS = 60;

export interface AttributedOutcome {
  opportunityFingerprint: string;
  opportunityType: string;
  subject: string;
  positionBefore: number | null;
  positionAfter: number | null;
  /** null when there was nothing to compare against — not a failure. */
  success: boolean | null;
}

/**
 * Attribute outcomes for ONE client's matured routings.
 *
 * Only `recover_keyword_position` produces a numeric before/after today, since
 * SERP position is the one producer metric with a directly comparable reading
 * on both sides. Other opportunity types are recorded with a null outcome
 * rather than a fabricated proxy metric.
 */
export async function attributeOutcomes(
  clientId: string,
  options: { now?: Date } = {},
): Promise<AttributedOutcome[]> {
  assertClientId(clientId);
  const now = options.now ?? new Date();
  const maturedBefore = new Date(now.getTime() - MATURATION_DAYS * 86_400_000);
  const notOlderThan = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000);
  const db = getDb();

  const links = await db
    .select({
      opportunityId: schema.intelligenceActionLinks.opportunityId,
      linkedAt: schema.intelligenceActionLinks.linkedAt,
    })
    .from(schema.intelligenceActionLinks)
    .where(
      and(
        eq(schema.intelligenceActionLinks.clientId, clientId),
        lte(schema.intelligenceActionLinks.linkedAt, maturedBefore),
        gte(schema.intelligenceActionLinks.linkedAt, notOlderThan),
      ),
    );

  if (links.length === 0) return [];

  const opportunityIds = [...new Set(links.map((l) => l.opportunityId))];
  const opportunities = await db
    .select({
      id: schema.intelligenceOpportunities.id,
      opportunityType: schema.intelligenceOpportunities.opportunityType,
      fingerprint: schema.intelligenceOpportunities.fingerprint,
      signalFingerprints: schema.intelligenceOpportunities.signalFingerprints,
    })
    .from(schema.intelligenceOpportunities)
    .where(
      and(
        eq(schema.intelligenceOpportunities.clientId, clientId),
        inArray(schema.intelligenceOpportunities.id, opportunityIds),
      ),
    );

  const linkedAtById = new Map(links.map((l) => [l.opportunityId, l.linkedAt]));
  const outcomes: AttributedOutcome[] = [];

  for (const opportunity of opportunities) {
    const signalFingerprints = (opportunity.signalFingerprints ?? []) as string[];
    if (signalFingerprints.length === 0) continue;

    const signals = await db
      .select({
        subject: schema.intelligenceSignals.subject,
        signalType: schema.intelligenceSignals.signalType,
        evidence: schema.intelligenceSignals.evidence,
      })
      .from(schema.intelligenceSignals)
      .where(
        and(
          eq(schema.intelligenceSignals.clientId, clientId),
          inArray(schema.intelligenceSignals.fingerprint, signalFingerprints),
        ),
      );

    const keywordSignal = signals.find((s) => s.signalType === "keyword_drop");
    if (!keywordSignal) {
      outcomes.push({
        opportunityFingerprint: opportunity.fingerprint,
        opportunityType: opportunity.opportunityType,
        subject: signals[0]?.subject ?? "",
        positionBefore: null,
        positionAfter: null,
        success: null,
      });
      continue;
    }

    const evidence = (keywordSignal.evidence ?? {}) as Record<string, unknown>;
    const positionBefore =
      typeof evidence.currentPosition === "number" ? evidence.currentPosition : null;

    const linkedAt = linkedAtById.get(opportunity.id) ?? now;
    const [latest] = await db
      .select({ position: schema.serpRankings.position })
      .from(schema.serpRankings)
      .where(
        and(
          eq(schema.serpRankings.clientId, clientId),
          eq(schema.serpRankings.keyword, keywordSignal.subject),
          gte(schema.serpRankings.checkedAt, linkedAt),
        ),
      )
      .orderBy(desc(schema.serpRankings.checkedAt))
      .limit(1);

    const positionAfter = latest?.position ?? null;
    // A lower SERP position number is better. Both readings must exist for a
    // verdict; one of them missing leaves `success` null.
    const success =
      positionBefore !== null && positionAfter !== null ? positionAfter < positionBefore : null;

    outcomes.push({
      opportunityFingerprint: opportunity.fingerprint,
      opportunityType: opportunity.opportunityType,
      subject: keywordSignal.subject,
      positionBefore,
      positionAfter,
      success,
    });

    await db.insert(schema.actionOutcomes).values({
      clientId,
      module: "intelligence",
      action: `intelligence:${opportunity.opportunityType}`,
      executedAt: linkedAt,
      measuredAt: now,
      positionBefore,
      positionAfter,
      success,
      learnings:
        `Observed over ${MATURATION_DAYS}d after routing. Correlation only — other ` +
        `factors (competitor moves, algorithm updates) are not controlled for.`,
    });
  }

  logger.info({ clientId, count: outcomes.length }, "outcomes attributed");
  return outcomes;
}
