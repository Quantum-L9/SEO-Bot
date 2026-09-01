/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Opportunity Scoring
 *
 * Clusters signals into opportunities and ranks them.
 *
 * SCORING IS DETERMINISTIC AND LLM-FREE, BY CONTRACT.
 * No function in this file may call a model. Scoring decides what the loop acts
 * on first; if it were model-driven it would be unreproducible, unauditable,
 * unbounded in cost, and a prompt-injected competitor title could reorder the
 * queue. Judgment belongs in the planner, which runs after the gate and can
 * only choose from a closed vocabulary. This is arithmetic over rules-derived
 * signal fields and nothing else.
 *
 * A SINGLE SIGNAL RARELY JUSTIFIES ACTION.
 * The value of the substrate is correlation: a keyword drop is ambiguous, but a
 * keyword drop plus a slow page plus a lost citation on the same URL is a
 * content-refresh case. Clustering is what turns telemetry into a decision.
 */

import { createHash } from "node:crypto";
import { createModuleLogger } from "../../core/logger.js";
import { assertClientId } from "./queries/index.js";
import type { ExtractedSignal, SignalSeverity } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:scorer");

export type OpportunityType =
  | "content_refresh"
  | "technical_seo_fix"
  | "aeo_answer_block"
  | "link_building"
  | "budget_risk"
  | "job_reliability";

export interface ScoredOpportunity {
  clientId: string;
  opportunityType: OpportunityType;
  fingerprint: string;
  title: string;
  description: string;
  targetUrl: string | null;
  targetKeyword: string | null;
  expectedImpact: number;
  confidence: number;
  urgency: number;
  effort: number;
  risk: number;
  score: number;
  signalFingerprints: string[];
  evidence: Record<string, unknown>;
  rationale: string;
}

/** Signal family -> the opportunity it contributes to. */
const SIGNAL_TO_OPPORTUNITY: Record<string, OpportunityType> = {
  keyword_drop: "content_refresh",
  bad_lcp_high_exit: "technical_seo_fix",
  citation_loss: "aeo_answer_block",
  prospect_ready: "link_building",
  llm_budget_pressure: "budget_risk",
  job_failure_cluster: "job_reliability",
};

/**
 * Severity -> expected impact, on a 0..100 scale.
 *
 * The scale is 0..100 rather than 0..1 so that the final score lands in the
 * same range, which is what makes INTELLIGENCE_MIN_SCORE_TO_PLAN=50 mean
 * something an operator can reason about ("act on roughly the top half")
 * instead of an opaque fraction.
 */
const SEVERITY_IMPACT: Record<SignalSeverity, number> = {
  low: 25,
  medium: 50,
  high: 75,
  critical: 100,
};

/**
 * Effort and risk are properties of the REMEDY, not of the observation, so they
 * are constants of the opportunity type. `risk` means "risk of the action we
 * would take", which is why contacting a stranger scores far above editing a
 * page.
 *
 * CALIBRATION MATTERS MORE THAN THE INDIVIDUAL NUMBERS.
 * The denominator is `max(1, effort + risk)`, and the numerator is
 * `impact(0..100) * confidence(0..1) * urgency(0..1)` — two sub-1 factors
 * multiplying down hard. So the sums here are kept in a 1.0-2.4 band. Pushed
 * higher, a realistic opportunity (high severity, 0.7 confidence, 0.7 urgency
 * = 37 before division) could never clear INTELLIGENCE_MIN_SCORE_TO_PLAN=50 and
 * the primary use case would be silently disabled by the default config.
 * Pushed to 1.0 across the board, `max(1, ...)` would always select 1 and both
 * factors would stop affecting the ranking at all.
 *
 * ONE CONSEQUENCE IS DELIBERATE. `link_building` sums to 2.4, so its ceiling is
 * ~42 and it cannot clear the default threshold: the only irreversible path in
 * the module requires an operator to lower INTELLIGENCE_MIN_SCORE_TO_PLAN on
 * purpose. That is not a silent no-op — every such block is written to the
 * decision ledger with its score and the threshold it missed.
 */
const OPPORTUNITY_COST: Record<OpportunityType, { effort: number; risk: number }> = {
  content_refresh: { effort: 0.8, risk: 0.4 },
  technical_seo_fix: { effort: 0.6, risk: 0.3 },
  aeo_answer_block: { effort: 0.5, risk: 0.2 },
  link_building: { effort: 1.0, risk: 1.4 },
  budget_risk: { effort: 0.3, risk: 0.1 },
  job_reliability: { effort: 0.4, risk: 0.1 },
};

const OPPORTUNITY_TITLE: Record<OpportunityType, string> = {
  content_refresh: "Refresh content for slipping keywords",
  technical_seo_fix: "Fix slow, high-exit pages",
  aeo_answer_block: "Recover lost answer-engine citations",
  link_building: "Contact qualified link prospects",
  budget_risk: "LLM spend approaching the daily cap",
  job_reliability: "Repeated job failures need operator attention",
};

export function opportunityFingerprint(
  clientId: string,
  opportunityType: OpportunityType,
  signalFingerprints: string[],
): string {
  // Sorted so the same cluster observed in a different order hashes
  // identically — otherwise a reordered extraction looks like a new
  // opportunity and defeats the unique index.
  const sorted = [...signalFingerprints].sort();
  return createHash("sha256")
    .update(`${clientId}|${opportunityType}|${sorted.join(",")}`)
    .digest("hex");
}

/**
 * Is this signal too old to justify new action?
 *
 * Measured from `observedAt`, which extraction refreshes every run. So "stale"
 * means the underlying condition stopped being observed — the keyword
 * recovered, the page got fixed — not merely that the row is old.
 */
export function isStale(observedAt: Date, staleDays: number, now: Date = new Date()): boolean {
  return now.getTime() - observedAt.getTime() > staleDays * 24 * 60 * 60 * 1000;
}

/**
 * Urgency: how fresh and how severe, on 0..1.
 *
 * Recency is deliberately part of urgency rather than of impact. A critical
 * problem observed today and the same problem last seen three weeks ago have
 * identical impact; only one of them is worth interrupting today's queue for.
 */
export function urgencyFor(
  signals: ScorableSignal[],
  staleDays: number,
  now: Date = new Date(),
): number {
  if (signals.length === 0) return 0;
  let best = 0;
  for (const signal of signals) {
    const severityWeight = (SEVERITY_IMPACT[signal.severity] ?? 0) / 100;
    const observedAt = signal.observedAt ?? now;
    const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / (24 * 60 * 60 * 1000));
    const recency = Math.max(0, 1 - ageDays / staleDays);
    best = Math.max(best, severityWeight * 0.5 + recency * 0.5);
  }
  return round4(clamp01(best));
}

export type ScorableSignal = ExtractedSignal;

export interface ScoreOptions {
  staleDays?: number;
  now?: Date;
}

/**
 * Score one cluster.
 *
 *   score = (expectedImpact * confidence * urgency) / max(1, effort + risk)
 *
 * Multiplicative in the numerator because these are not interchangeable: an
 * opportunity nobody is confident in should not be rescued by a large impact
 * estimate, and a stale one should not be rescued by either. A weighted sum
 * lets one strong term mask a disqualifying one; a product does not.
 *
 * The denominator is additive and floored at 1 so that cheap, safe work is
 * never divided into irrelevance while genuinely expensive or dangerous work
 * (link building) is meaningfully discounted.
 */
export function scoreCluster(
  clientId: string,
  opportunityType: OpportunityType,
  signals: ScorableSignal[],
  options: ScoreOptions = {},
): ScoredOpportunity {
  const staleDays = options.staleDays ?? 14;
  const now = options.now ?? new Date();
  const cost = OPPORTUNITY_COST[opportunityType];

  // Impact: the worst signal sets the ceiling; additional signals add a bounded
  // corroboration bonus. Averaging would let a pile of trivial signals dilute
  // one critical one. Clamped at 0 because an empty cluster has no
  // corroboration, not anti-corroboration.
  const impacts = signals.map((s) => SEVERITY_IMPACT[s.severity] ?? 0);
  const peak = impacts.length > 0 ? Math.max(...impacts) : 0;
  const corroboration = Math.max(0, Math.min(20, (signals.length - 1) * 5));
  const expectedImpact = Math.min(100, peak + corroboration);

  // Confidence: mean rules-derived confidence across the cluster.
  const confidence =
    signals.length > 0
      ? signals.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / signals.length
      : 0;

  const urgency = urgencyFor(signals, staleDays, now);
  const score = (expectedImpact * confidence * urgency) / Math.max(1, cost.effort + cost.risk);

  const targetUrl = firstEvidenceString(signals, ["url", "target_url", "path"]);
  const targetKeyword = firstEvidenceString(signals, ["keyword"]);

  return {
    clientId,
    opportunityType,
    fingerprint: opportunityFingerprint(
      clientId,
      opportunityType,
      signals.map((s) => s.fingerprint),
    ),
    title: OPPORTUNITY_TITLE[opportunityType],
    description: `${signals.length} ${opportunityType} signal(s); peak severity ${maxSeverity(signals)}.`,
    targetUrl,
    targetKeyword,
    expectedImpact: round4(expectedImpact),
    confidence: round4(confidence),
    urgency,
    effort: cost.effort,
    risk: cost.risk,
    score: round4(score),
    signalFingerprints: signals.map((s) => s.fingerprint).sort(),
    evidence: {
      signalTypes: [...new Set(signals.map((s) => s.signalType))],
      entityKeys: signals.slice(0, 10).map((s) => s.entityKey),
    },
    rationale:
      `impact ${round4(expectedImpact)} x confidence ${round4(confidence)} x urgency ${urgency} ` +
      `/ max(1, effort ${cost.effort} + risk ${cost.risk}) = ${round4(score)}`,
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Rounds to 4dp and normalizes -0, which otherwise surfaces in stored scores. */
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

/** First non-empty string under any of `keys` across the cluster's evidence. */
function firstEvidenceString(signals: ScorableSignal[], keys: string[]): string | null {
  for (const signal of signals) {
    for (const key of keys) {
      const value = signal.evidence?.[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return null;
}

/**
 * Cluster signals into scored opportunities.
 *
 * Suppressed and stale signals are dropped BEFORE clustering, not filtered out
 * of the result: a suppressed signal must not contribute its severity to a
 * surviving cluster's peak impact, which is what post-filtering would allow.
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
    opportunities.push(scoreCluster(clientId, opportunityType, clustered, { staleDays, now }));
  }

  logger.debug({ clientId, opportunities: opportunities.length }, "Scoring complete");
  return opportunities.sort((a, b) => b.score - a.score);
}
