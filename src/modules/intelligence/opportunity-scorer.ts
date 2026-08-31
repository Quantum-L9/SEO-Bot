/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: opportunity scoring
 *
 * Turns open signals into scored, ranked opportunities.
 *
 * DETERMINISTIC BY CONSTRUCTION. No LLM participates in scoring, and the score
 * is a pure function of the stored signal rows: the same signals always produce
 * the same number. That is what makes the ranking auditable — an operator can
 * ask "why is this first" and get an arithmetic answer rather than a narrative
 * one — and it is why an LLM is allowed to plan against these scores but never
 * to produce them.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq } from "drizzle-orm";
import { getConfig } from "../../core/config.js";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { opportunityFingerprint } from "./fingerprint.js";
import { assertClientId } from "./policy-gate.js";
import type { Opportunity, OpportunityType, SignalSeverity, SignalType } from "./types.js";

const logger = createModuleLogger("intelligence:scorer");

/** Which opportunity each signal type argues for. Closed, one-to-one map. */
const SIGNAL_TO_OPPORTUNITY: Record<SignalType, OpportunityType> = {
  keyword_drop: "recover_keyword_position",
  bad_lcp_high_exit: "fix_page_experience",
  citation_loss: "regain_answer_citation",
  prospect_ready: "pursue_link_prospect",
};

/**
 * Base weights per opportunity type, on 0..1 scales.
 *
 * `effort` is a cost and `risk` is a penalty, so both push the score DOWN;
 * `impact` and `confidence` push it up. The numbers encode the ordinary
 * economics of each play: recovering a lost ranking is high-impact and cheap,
 * chasing a single backlink is low-impact and slow.
 */
const BASE_WEIGHTS: Record<
  OpportunityType,
  { impact: number; confidence: number; effort: number; risk: number }
> = {
  recover_keyword_position: { impact: 0.9, confidence: 0.8, effort: 0.4, risk: 0.2 },
  fix_page_experience: { impact: 0.7, confidence: 0.85, effort: 0.5, risk: 0.15 },
  regain_answer_citation: { impact: 0.6, confidence: 0.6, effort: 0.4, risk: 0.2 },
  // Outreach is irreversible and lands in someone's inbox — the highest risk
  // weight in the table, so it has to out-argue the others to be ranked first.
  pursue_link_prospect: { impact: 0.5, confidence: 0.55, effort: 0.7, risk: 0.5 },
};

/** Severity raises the impact of an otherwise identical opportunity. */
const SEVERITY_IMPACT_MULTIPLIER: Record<SignalSeverity, number> = {
  info: 0.8,
  warning: 1.0,
  critical: 1.25,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The score, on 0..100.
 *
 *   score = 100 × impact × confidence × (1 − risk) ÷ (0.5 + effort)
 *
 * Multiplying impact by confidence means an uncertain big win and a certain
 * small one land near each other, which is the honest reading — and it makes
 * `(1 − risk)` able to veto: a maximally risky action scores zero no matter how
 * large its claimed impact. `effort` divides through an offset of 0.5 so a
 * near-zero-effort action gets a strong but finite boost rather than exploding.
 */
export function computeScore(params: {
  impact: number;
  confidence: number;
  effort: number;
  risk: number;
}): number {
  const impact = clamp01(params.impact);
  const confidence = clamp01(params.confidence);
  const effort = clamp01(params.effort);
  const risk = clamp01(params.risk);

  const raw = (100 * impact * confidence * (1 - risk)) / (0.5 + effort);
  // Two decimals: enough to rank stably, few enough that the value is
  // reproducible across platforms rather than carrying float noise.
  return Math.round(Math.min(100, raw) * 100) / 100;
}

interface ScoredSignalRow {
  signalType: SignalType;
  fingerprint: string;
  severity: SignalSeverity;
  subject: string;
  observedAt: Date;
}

/**
 * Is this signal too old to act on?
 *
 * A stale signal is not evidence about now. Acting on a two-week-old ranking
 * drop that has since recovered spends budget on a problem that no longer
 * exists, so stale signals are excluded rather than merely discounted.
 */
export function isStale(observedAt: Date, now: Date, ttlHours: number): boolean {
  return now.getTime() - observedAt.getTime() > ttlHours * 3_600_000;
}

/**
 * Score the open signals for ONE client into deduplicated opportunities.
 *
 * Excluded, in order: signals not `open` (an operator suppressed them),
 * signals past their TTL, and signal types with no mapped opportunity.
 * Remaining signals are clustered by (opportunity type, subject), so several
 * readings about the same page produce one opportunity, not three.
 */
export async function scoreOpportunities(
  clientId: string,
  options: { now?: Date } = {},
): Promise<Opportunity[]> {
  assertClientId(clientId);
  const now = options.now ?? new Date();
  const ttlHours = getConfig().INTELLIGENCE_SIGNAL_TTL_HOURS;
  const db = getDb();

  const rows = (await db
    .select({
      signalType: schema.intelligenceSignals.signalType,
      fingerprint: schema.intelligenceSignals.fingerprint,
      severity: schema.intelligenceSignals.severity,
      subject: schema.intelligenceSignals.subject,
      observedAt: schema.intelligenceSignals.observedAt,
    })
    .from(schema.intelligenceSignals)
    .where(
      and(
        eq(schema.intelligenceSignals.clientId, clientId),
        eq(schema.intelligenceSignals.status, "open"),
      ),
    )) as ScoredSignalRow[];

  const fresh = rows.filter((row) => !isStale(row.observedAt, now, ttlHours));

  // Cluster by what the work would actually be: the same page appearing under
  // two signals is one job to do, not two.
  const clusters = new Map<
    string,
    { type: OpportunityType; subject: string; rows: ScoredSignalRow[] }
  >();
  for (const row of fresh) {
    const opportunityType = SIGNAL_TO_OPPORTUNITY[row.signalType];
    if (!opportunityType) continue;
    const key = `${opportunityType}::${row.subject}`;
    const cluster = clusters.get(key) ?? { type: opportunityType, subject: row.subject, rows: [] };
    cluster.rows.push(row);
    clusters.set(key, cluster);
  }

  const opportunities: Opportunity[] = [];
  for (const cluster of clusters.values()) {
    const base = BASE_WEIGHTS[cluster.type];
    const worstSeverity = cluster.rows.reduce<SignalSeverity>(
      (worst, row) =>
        SEVERITY_IMPACT_MULTIPLIER[row.severity] > SEVERITY_IMPACT_MULTIPLIER[worst]
          ? row.severity
          : worst,
      "info",
    );

    const impact = clamp01(base.impact * SEVERITY_IMPACT_MULTIPLIER[worstSeverity]);
    // Corroboration raises confidence, with a ceiling: three readings agreeing
    // is meaningfully better than one, ten is not meaningfully better than three.
    const corroboration = Math.min(cluster.rows.length, 3);
    const confidence = clamp01(base.confidence + 0.05 * (corroboration - 1));
    const { effort, risk } = base;

    const signalFingerprints = cluster.rows.map((row) => row.fingerprint).sort();

    opportunities.push({
      clientId,
      opportunityType: cluster.type,
      fingerprint: opportunityFingerprint(clientId, cluster.type, signalFingerprints),
      score: computeScore({ impact, confidence, effort, risk }),
      impact,
      confidence,
      effort,
      risk,
      signalFingerprints,
      rationale:
        `${cluster.rows.length} ${worstSeverity} signal(s) of type ` +
        `${[...new Set(cluster.rows.map((r) => r.signalType))].join(", ")} for "${cluster.subject}"`,
    });
  }

  opportunities.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));
  await persistOpportunities(clientId, opportunities, now);

  logger.info({ clientId, count: opportunities.length }, "opportunities scored");
  return opportunities;
}

/**
 * Upsert on (client_id, fingerprint).
 *
 * `status` is not in the update set: re-scoring must not reopen an opportunity
 * that was already routed or dismissed, or the loop would route it again on
 * every cycle.
 */
async function persistOpportunities(
  clientId: string,
  opportunities: Opportunity[],
  now: Date,
): Promise<void> {
  if (opportunities.length === 0) return;
  const db = getDb();

  for (const opportunity of opportunities) {
    await db
      .insert(schema.intelligenceOpportunities)
      .values({
        clientId,
        opportunityType: opportunity.opportunityType,
        fingerprint: opportunity.fingerprint,
        score: opportunity.score,
        impact: opportunity.impact,
        confidence: opportunity.confidence,
        effort: opportunity.effort,
        risk: opportunity.risk,
        status: "open",
        signalFingerprints: opportunity.signalFingerprints,
        rationale: opportunity.rationale,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.intelligenceOpportunities.clientId,
          schema.intelligenceOpportunities.fingerprint,
        ],
        set: {
          score: opportunity.score,
          impact: opportunity.impact,
          confidence: opportunity.confidence,
          effort: opportunity.effort,
          risk: opportunity.risk,
          rationale: opportunity.rationale,
          updatedAt: now,
        },
      });
  }
}
