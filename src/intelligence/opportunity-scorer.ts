/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Opportunity Scorer (ADR-0016)
 *
 * Turns a flat list of signals into ranked work.
 *
 * This is where SQL stops being a reporting convenience and becomes leverage:
 * a keyword drop, a slow page, and a lost citation are three separate module
 * findings, but when they land on the SAME page they are one problem with one
 * fix. Grouping by target is what lets the bot act on the problem instead of
 * three times on its symptoms.
 *
 * Pure and synchronous — no database, no clock, no LLM. Ranking the portfolio
 * is a deterministic calculation, and a deterministic calculation is one that can
 * be tested, explained to an operator, and reproduced from the stored evidence.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  type OpportunityType,
  opportunityFingerprint,
  type ScoredOpportunity,
  SEVERITY_RANK,
  type SignalCandidate,
  type SignalType,
} from "./types.js";

/**
 * Static cost/benefit shape per opportunity type.
 *
 * `impact` and `effort` are on a 0..10 scale; `risk` is 0..10 where higher means
 * more chance of making things worse. These are deliberately hand-set constants
 * rather than model output: the ranking must be stable and explicable, and a
 * number an LLM invented cannot be either.
 */
interface OpportunityShape {
  readonly impact: number;
  readonly effort: number;
  readonly risk: number;
  readonly title: string;
  readonly describe: (signals: readonly SignalCandidate[], target: string | null) => string;
}

const OPPORTUNITY_SHAPES: Readonly<Record<OpportunityType, OpportunityShape>> = {
  keyword_drop_plus_page_experience: {
    impact: 9,
    effort: 4,
    risk: 2,
    title: "Ranking loss on a page with poor experience",
    describe: (signals, target) =>
      `A keyword lost ground while ${target ?? "the target page"} also shows poor engagement and ` +
      `Core Web Vitals. Treat the page, not the keyword: ${describeSignals(signals)}.`,
  },
  serp_and_answer_engine_loss: {
    impact: 8,
    effort: 5,
    risk: 2,
    title: "Losing both classic search and answer engines",
    describe: (signals, target) =>
      `${target ?? "This target"} is losing organic position and answer-engine citations at the ` +
      `same time, which usually means a competitor's content now answers the query better: ` +
      `${describeSignals(signals)}.`,
  },
  keyword_recovery: {
    impact: 6,
    effort: 3,
    risk: 2,
    title: "Keyword ranking recovery",
    describe: (signals, target) =>
      `${target ?? "A tracked keyword"} dropped without an accompanying experience or citation ` +
      `signal: ${describeSignals(signals)}.`,
  },
  page_experience_repair: {
    impact: 6,
    effort: 3,
    risk: 1,
    title: "Page experience repair",
    describe: (signals, target) =>
      `${target ?? "A page"} combines high exit rate with slow loading; visitors are arriving and ` +
      `leaving: ${describeSignals(signals)}.`,
  },
  performance_regression: {
    impact: 5,
    effort: 3,
    risk: 1,
    title: "Core Web Vitals regression",
    describe: (signals, target) =>
      `Largest Contentful Paint regressed on ${target ?? "a page"}: ${describeSignals(signals)}.`,
  },
  answer_engine_gap: {
    impact: 6,
    effort: 4,
    risk: 1,
    title: "Answer-engine citation gap",
    describe: (signals, target) =>
      `Citation rate is falling or a competitor is being cited instead on ` +
      `${target ?? "this platform"}: ${describeSignals(signals)}.`,
  },
  link_outreach_batch: {
    impact: 5,
    effort: 2,
    risk: 3,
    title: "High-authority prospects awaiting outreach",
    describe: (signals) =>
      `Discovered prospects meet the authority bar and have not been contacted: ` +
      `${describeSignals(signals)}.`,
  },
  budget_review: {
    impact: 4,
    effort: 1,
    risk: 1,
    title: "LLM budget pressure",
    describe: (signals) => `Token spend is approaching its cap: ${describeSignals(signals)}.`,
  },
  pipeline_repair: {
    impact: 7,
    effort: 2,
    risk: 1,
    title: "Repeated job failures",
    describe: (signals) =>
      `A scheduled job has failed repeatedly, so the data behind every other decision for this ` +
      `client may be stale: ${describeSignals(signals)}.`,
  },
};

function describeSignals(signals: readonly SignalCandidate[]): string {
  return signals
    .map((signal) => `${signal.signalType} (${signal.severity}) on ${signal.entityId}`)
    .join("; ");
}

/**
 * Ordered most-specific-first. The first rule whose required signal types are
 * ALL present in the group wins, so a page carrying both a ranking drop and an
 * experience problem becomes one combined opportunity rather than two thin ones.
 */
interface GroupingRule {
  readonly opportunityType: OpportunityType;
  readonly requires: readonly SignalType[];
}

export const GROUPING_RULES: readonly GroupingRule[] = [
  {
    opportunityType: "keyword_drop_plus_page_experience",
    requires: ["keyword_drop", "high_exit_bad_lcp"],
  },
  {
    opportunityType: "serp_and_answer_engine_loss",
    requires: ["keyword_drop", "competitor_citation_gain"],
  },
  {
    opportunityType: "serp_and_answer_engine_loss",
    requires: ["keyword_drop", "citation_rate_down"],
  },
  { opportunityType: "page_experience_repair", requires: ["high_exit_bad_lcp"] },
  { opportunityType: "keyword_recovery", requires: ["keyword_drop"] },
  { opportunityType: "performance_regression", requires: ["lcp_regression"] },
  { opportunityType: "answer_engine_gap", requires: ["competitor_citation_gain"] },
  { opportunityType: "answer_engine_gap", requires: ["citation_rate_down"] },
  { opportunityType: "link_outreach_batch", requires: ["prospect_high_dr_ready"] },
  { opportunityType: "pipeline_repair", requires: ["job_failure_cluster"] },
  { opportunityType: "budget_review", requires: ["llm_budget_pressure"] },
];

export function classifyGroup(signals: readonly SignalCandidate[]): OpportunityType | null {
  const present = new Set(signals.map((signal) => signal.signalType));
  for (const rule of GROUPING_RULES) {
    if (rule.requires.every((required) => present.has(required))) return rule.opportunityType;
  }
  return null;
}

/** Max severity in the group, normalized to 0.25..1.0. */
export function urgencyFromSignals(signals: readonly SignalCandidate[]): number {
  if (signals.length === 0) return 0;
  const peak = Math.max(...signals.map((signal) => SEVERITY_RANK[signal.severity]));
  return peak / 4;
}

/** Mean extractor confidence, clamped into 0..1. */
export function confidenceFromSignals(signals: readonly SignalCandidate[]): number {
  if (signals.length === 0) return 0;
  const total = signals.reduce((sum, signal) => sum + signal.confidence, 0);
  return Math.min(1, Math.max(0, total / signals.length));
}

/**
 * score = impact × confidence × urgency ÷ max(effort + risk, 1)
 *
 * Scaled ×10 so scores land on a readable 0..100-ish band rather than 0..9, and
 * rounded to four decimals to match the column's numeric(10,4) precision — a
 * score that changes when it round-trips through the database is not a ranking.
 */
export function computeScore(input: {
  expectedImpact: number;
  confidence: number;
  urgency: number;
  effort: number;
  risk: number;
}): number {
  const denominator = Math.max(input.effort + input.risk, 1);
  const raw = (input.expectedImpact * input.confidence * input.urgency * 10) / denominator;
  return Math.round(raw * 10_000) / 10_000;
}

/**
 * Group signals by target and score each group.
 *
 * Signals whose combination matches no rule are not dropped silently — they stay
 * in the signals table and are reported by the caller as ungrouped, because a
 * finding nobody can act on is still evidence that an extractor needs a rule.
 */
export function buildOpportunities(signals: readonly SignalCandidate[]): {
  opportunities: ScoredOpportunity[];
  ungrouped: SignalCandidate[];
} {
  const groups = new Map<string, SignalCandidate[]>();
  for (const signal of signals) {
    const key = `${signal.clientId}::${signal.groupKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(signal);
    else groups.set(key, [signal]);
  }

  const opportunities: ScoredOpportunity[] = [];
  const ungrouped: SignalCandidate[] = [];

  for (const [, groupSignals] of groups) {
    const opportunityType = classifyGroup(groupSignals);
    if (!opportunityType) {
      ungrouped.push(...groupSignals);
      continue;
    }

    const shape = OPPORTUNITY_SHAPES[opportunityType];
    const first = groupSignals[0];
    const urgency = urgencyFromSignals(groupSignals);
    const confidence = confidenceFromSignals(groupSignals);

    const targetUrl =
      pickEvidenceString(groupSignals, "page_path") ?? pickEvidenceString(groupSignals, "url");
    const targetKeyword =
      pickEvidenceString(groupSignals, "keyword") ??
      (groupSignals.some((signal) => signal.entityType === "keyword") ? first.entityId : null);

    opportunities.push({
      clientId: first.clientId,
      opportunityType,
      title: shape.title,
      description: shape.describe(groupSignals, targetUrl ?? targetKeyword),
      targetUrl,
      targetKeyword,
      expectedImpact: shape.impact,
      effort: shape.effort,
      risk: shape.risk,
      urgency,
      confidence,
      score: computeScore({
        expectedImpact: shape.impact,
        confidence,
        urgency,
        effort: shape.effort,
        risk: shape.risk,
      }),
      fingerprint: opportunityFingerprint(first.clientId, opportunityType, first.groupKey),
      signals: groupSignals,
      evidence: {
        group_key: first.groupKey,
        signal_types: [...new Set(groupSignals.map((signal) => signal.signalType))].sort(),
        signal_count: groupSignals.length,
        signals: groupSignals.map((signal) => ({
          signal_type: signal.signalType,
          entity_type: signal.entityType,
          entity_id: signal.entityId,
          severity: signal.severity,
          confidence: signal.confidence,
          evidence: signal.evidence,
        })),
      },
    });
  }

  // Highest score first; ties broken by fingerprint so the ordering is total and
  // reproducible rather than dependent on Map iteration order.
  opportunities.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));
  return { opportunities, ungrouped };
}

function pickEvidenceString(signals: readonly SignalCandidate[], key: string): string | null {
  for (const signal of signals) {
    const value = signal.evidence[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
