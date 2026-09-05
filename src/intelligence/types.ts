/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Plane Types (ADR-0016)
 *
 * The vocabulary of the reasoning loop:
 *   Observe → Diagnose → Prioritize → Plan → Act → Measure → Learn
 *
 * A SIGNAL is an observation. An OPPORTUNITY is a group of signals worth acting
 * on. A DECISION is what the bot chose and why. None of these mutate a site.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";

export type SignalSeverity = "low" | "medium" | "high" | "critical";

/** Closed set. A new signal type must be added here and to the extractor registry. */
export const SIGNAL_TYPES = [
  "keyword_drop",
  "lcp_regression",
  "high_exit_bad_lcp",
  "citation_rate_down",
  "competitor_citation_gain",
  "prospect_high_dr_ready",
  "llm_budget_pressure",
  "job_failure_cluster",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export type SignalEntityType = "keyword" | "page" | "platform" | "prospect" | "client" | "job";

/** A machine-readable observation. Never an instruction. */
export interface SignalCandidate {
  readonly clientId: string;
  readonly entityType: SignalEntityType;
  readonly entityId: string;
  readonly signalType: SignalType;
  readonly severity: SignalSeverity;
  /** 0..1 — how much the extractor trusts the observation, not how bad it is. */
  readonly confidence: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  /**
   * Grouping key: what this signal is ABOUT, normalized so signals from
   * different modules about the same page or keyword land in one opportunity.
   */
  readonly groupKey: string;
}

export type OpportunityType =
  | "keyword_drop_plus_page_experience"
  | "serp_and_answer_engine_loss"
  | "keyword_recovery"
  | "page_experience_repair"
  | "performance_regression"
  | "answer_engine_gap"
  | "link_outreach_batch"
  | "budget_review"
  | "pipeline_repair";

export interface ScoredOpportunity {
  readonly clientId: string;
  readonly opportunityType: OpportunityType;
  readonly title: string;
  readonly description: string;
  readonly targetUrl: string | null;
  readonly targetKeyword: string | null;
  readonly expectedImpact: number;
  readonly effort: number;
  readonly risk: number;
  readonly urgency: number;
  readonly confidence: number;
  readonly score: number;
  readonly fingerprint: string;
  readonly signals: readonly SignalCandidate[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** What the bot decided to do about an opportunity. */
export type DecisionKind =
  | "propose_action"
  | "defer_budget"
  | "suppress_duplicate"
  | "escalate_to_operator"
  | "run_diagnostic"
  | "no_action";

export const SEVERITY_RANK: Readonly<Record<SignalSeverity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Stable identity for "this observation about this entity".
 *
 * Deterministic and value-only: the same finding on the same entity produces the
 * same fingerprint across runs and processes, which is what makes both
 * suppression and run-level idempotency possible. Never include a timestamp.
 */
export function signalFingerprint(
  clientId: string,
  signalType: SignalType,
  entityId: string,
): string {
  return createHash("sha256")
    .update(`${clientId}:${signalType}:${entityId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Stable identity for an opportunity: its client, type, and grouping target. */
export function opportunityFingerprint(
  clientId: string,
  opportunityType: OpportunityType,
  groupKey: string,
): string {
  return createHash("sha256")
    .update(`${clientId}:${opportunityType}:${groupKey}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Normalize a URL or path into the grouping key used to co-locate signals.
 * `https://example.com/pricing?utm=x` and `/pricing` are the same page.
 */
export function normalizePageKey(input: string | null | undefined): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const withoutOrigin = input.replace(/^https?:\/\/[^/]+/i, "");
  const queryStart = withoutOrigin.search(/[?#]/);
  const withoutQuery = queryStart === -1 ? withoutOrigin : withoutOrigin.slice(0, queryStart);
  if (withoutQuery === "") return "/";
  const trimmed =
    withoutQuery.length > 1 && withoutQuery.endsWith("/")
      ? withoutQuery.slice(0, -1)
      : withoutQuery;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
