/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Opportunity Scoring
 *
 * Clusters signals into opportunities and scores them.
 *
 * SCORING IS DETERMINISTIC AND LLM-FREE, BY CONTRACT.
 * No function in this file may call an LLM. Scoring decides what the loop acts
 * on first; if it were model-driven it would be unreproducible, unauditable,
 * and unbounded in cost — and a prompt-injected competitor title could shift
 * the ranking. Judgment belongs in the planner, which runs AFTER the gate and
 * can only choose from a closed vocabulary. The score is arithmetic over
 * rules-derived signal fields, and nothing else.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { assertClientId, type ExtractedSignal, type SignalSeverity } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:scorer");

export type OpportunityType =
  | "recover_keyword_ranking"
  | "fix_slow_exit_page"
  | "recover_citation"
  | "acquire_backlink";

export interface ScoredOpportunity {
  clientId: string;
  opportunityType: OpportunityType;
  fingerprint: string;
  score: number;
  impact: number;
  confidence: number;
  effort: number;
  risk: number;
  signalFingerprints: string[];
  rationale: string;
}

/** Signal type → the opportunity it contributes to. */
const SIGNAL_TO_OPPORTUNITY: Record<string, OpportunityType> = {
  keyword_drop: "recover_keyword_ranking",
  bad_lcp_high_exit: "fix_slow_exit_page",
  citation_loss: "recover_citation",
  prospect_ready: "acquire_backlink",
};

/** Severity → impact weight. Ordered, and the only place severity becomes a number. */
const SEVERITY_IMPACT: Record<SignalSeverity, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
};

/**
 * Per-opportunity effort and risk. Both are properties of the REMEDY, not of
 * the signal, so they are constants of the opportunity type rather than
 * anything derived from the observation.
 *
 * `risk` here means "risk of the action we would take", which is why acquiring
 * a backlink (an irreversible email to a stranger) scores far above fixing a
 * slow page (a reversible content edit).
 */
const OPPORTUNITY_COST: Record<OpportunityType, { effort: number; risk: number }> = {
  recover_keyword_ranking: { effort: 0.5, risk: 0.2 },
  fix_slow_exit_page: { effort: 0.4, risk: 0.15 },
  recover_citation: { effort: 0.3, risk: 0.1 },
  acquire_backlink: { effort: 0.6, risk: 0.7 },
};

export function opportunityFingerprint(
  clientId: string,
  opportunityType: OpportunityType,
  signalFingerprints: string[],
): string {
  // Sorted so the same cluster in a different observation order hashes
  // identically — otherwise a reordered extraction would look like a new
  // opportunity and defeat the unique index.
  const sorted = [...signalFingerprints].sort();
  return createHash("sha256")
    .update(`${clientId}|${opportunityType}|${sorted.join(",")}`)
    .digest("hex");
}

/**
 * Is this signal too old to justify new action?
 *
 * Staleness is measured from `observedAt`, which the extractor refreshes on
 * every run. So "stale" means the underlying condition stopped being observed —
 * the keyword recovered, the page got fixed — not merely that the row is old.
 */
export function isStale(observedAt: Date, staleDays: number, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - observedAt.getTime();
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}

export interface ScorableSignal extends ExtractedSignal {
  status?: string;
  observedAt?: Date;
}

export interface ScoreOptions {
  staleDays?: number;
  now?: Date;
}

/**
 * Score one cluster. Pure: same inputs → same outputs, always.
 *
 * score = impact × confidence × (1 − risk) × (1 − effort/2)
 *
 * Multiplicative rather than a weighted sum, because these are not
 * interchangeable: an opportunity nobody is confident in should not be rescued
 * by a large impact estimate, and a high-risk action should be discounted no
 * matter how attractive the upside. A sum lets one strong term mask a
 * disqualifying one; a product does not.
 *
 * Effort is halved so it discounts rather than dominates — expensive work with
 * a big, certain payoff should still outrank a cheap trivial fix.
 */
export function scoreCluster(
  clientId: string,
  opportunityType: OpportunityType,
  signals: ScorableSignal[],
): ScoredOpportunity {
  const cost = OPPORTUNITY_COST[opportunityType];

  // Impact: the worst signal in the cluster sets the ceiling; additional
  // signals add a bounded corroboration bonus. Averaging would let a pile of
  // trivial signals dilute one critical one.
  const impacts = signals.map((s) => SEVERITY_IMPACT[s.severity] ?? 0);
  const peak = impacts.length > 0 ? Math.max(...impacts) : 0;
  // Clamped at 0: with an empty cluster `(length - 1) * 0.05` is NEGATIVE, which
  // would make impact negative and, multiplied through, yield -0. A cluster with
  // no signals has no corroboration, not anti-corroboration.
  const corroboration = Math.max(0, Math.min(0.2, (signals.length - 1) * 0.05));
  const impact = Math.min(1, peak + corroboration);

  // Confidence: mean rules-derived strength. Strength is how strongly the rule
  // fired, so its average is how much the evidence supports acting.
  const confidence =
    signals.length > 0
      ? signals.reduce((sum, s) => sum + (s.strength ?? 0), 0) / signals.length
      : 0;

  const score = impact * confidence * (1 - cost.risk) * (1 - cost.effort / 2);

  return {
    clientId,
    opportunityType,
    fingerprint: opportunityFingerprint(
      clientId,
      opportunityType,
      signals.map((s) => s.fingerprint),
    ),
    score: round4(score),
    impact: round4(impact),
    confidence: round4(confidence),
    effort: cost.effort,
    risk: cost.risk,
    signalFingerprints: signals.map((s) => s.fingerprint).sort(),
    rationale:
      `${signals.length} ${opportunityType} signal(s); ` +
      `peak severity ${maxSeverity(signals)}; ` +
      `impact ${round4(impact)} × confidence ${round4(confidence)} ` +
      `× (1-risk ${cost.risk}) × (1-effort/2 ${cost.effort / 2})`,
  };
}

/**
 * Round to 4dp, normalizing -0 to 0.
 *
 * `-0` compares equal to `0` with `===` but not with `Object.is`, so it passes
 * arithmetic unnoticed and then surfaces as a confusing "-0" in a stored score
 * or a test diff. Adding 0 collapses it.
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000 + 0;
}

function maxSeverity(signals: ScorableSignal[]): SignalSeverity {
  let best: SignalSeverity = "low";
  for (const s of signals) {
    if ((SEVERITY_IMPACT[s.severity] ?? 0) > (SEVERITY_IMPACT[best] ?? 0)) best = s.severity;
  }
  return best;
}

/**
 * Cluster signals into scored opportunities.
 *
 * Suppressed and stale signals are dropped BEFORE clustering, not filtered out
 * of the result: a suppressed signal must not contribute its severity to a
 * cluster's peak impact, which is what post-filtering would allow.
 *
 * Signals of one type collapse into exactly one opportunity per client, so a
 * duplicate cluster is structurally impossible — the fingerprint is over the
 * whole sorted set, not over any single member.
 */
export function scoreOpportunitiesFromSignals(
  clientId: string,
  signals: ScorableSignal[],
  options: ScoreOptions = {},
): ScoredOpportunity[] {
  assertClientId(clientId);
  const staleDays = options.staleDays ?? 14;
  const now = options.now ?? new Date();

  const eligible = signals.filter((signal) => {
    if (signal.clientId !== clientId) return false;
    if (signal.status && signal.status !== "open") return false;
    if (signal.observedAt && isStale(signal.observedAt, staleDays, now)) return false;
    return true;
  });

  const byType = new Map<OpportunityType, ScorableSignal[]>();
  for (const signal of eligible) {
    const opportunityType = SIGNAL_TO_OPPORTUNITY[signal.signalType];
    if (!opportunityType) continue;
    const bucket = byType.get(opportunityType);
    if (bucket) bucket.push(signal);
    else byType.set(opportunityType, [signal]);
  }

  const opportunities: ScoredOpportunity[] = [];
  for (const [opportunityType, clustered] of byType) {
    opportunities.push(scoreCluster(clientId, opportunityType, clustered));
  }

  // Highest score first — the router's per-run cap takes from the top.
  return opportunities.sort((a, b) => b.score - a.score);
}

/** Load this client's open signals from the DB and score them. */
export async function scoreOpportunities(
  clientId: string,
  options: ScoreOptions = {},
): Promise<ScoredOpportunity[]> {
  assertClientId(clientId);
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.intelligenceSignals)
    .where(
      and(
        eq(schema.intelligenceSignals.clientId, clientId),
        eq(schema.intelligenceSignals.status, "open"),
      ),
    )
    .limit(1000);

  const signals: ScorableSignal[] = rows.map((row) => ({
    clientId: row.clientId,
    signalType: row.signalType as ExtractedSignal["signalType"],
    fingerprint: row.fingerprint,
    entityKey: row.entityKey,
    severity: row.severity as SignalSeverity,
    strength: row.strength ?? 0,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    status: row.status,
    observedAt: row.observedAt,
  }));

  const scored = scoreOpportunitiesFromSignals(clientId, signals, options);
  logger.info(
    { clientId, signals: signals.length, opportunities: scored.length },
    "Scoring complete",
  );
  return scored;
}

/**
 * Upsert opportunities on (client_id, fingerprint).
 *
 * As with signals, `status` is excluded from the update set so a run cannot
 * reopen an opportunity an operator resolved or dismissed.
 */
export async function persistOpportunities(
  opportunities: ScoredOpportunity[],
): Promise<Array<{ id: string; fingerprint: string }>> {
  if (opportunities.length === 0) return [];
  const db = getDb();

  return db
    .insert(schema.intelligenceOpportunities)
    .values(
      opportunities.map((opportunity) => ({
        clientId: opportunity.clientId,
        opportunityType: opportunity.opportunityType,
        fingerprint: opportunity.fingerprint,
        score: opportunity.score,
        impact: opportunity.impact,
        confidence: opportunity.confidence,
        effort: opportunity.effort,
        risk: opportunity.risk,
        signalFingerprints: opportunity.signalFingerprints,
        rationale: opportunity.rationale,
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.intelligenceOpportunities.clientId,
        schema.intelligenceOpportunities.fingerprint,
      ],
      set: {
        score: sql`excluded.score`,
        impact: sql`excluded.impact`,
        confidence: sql`excluded.confidence`,
        rationale: sql`excluded.rationale`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: schema.intelligenceOpportunities.id,
      fingerprint: schema.intelligenceOpportunities.fingerprint,
    });
}
