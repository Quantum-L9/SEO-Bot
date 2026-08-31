/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence Control Loop: shared types
 *
 * The loop is four deterministic stages plus one optional LLM stage:
 *
 *   extract signals → score opportunities → plan actions → route jobs
 *                                              ↑
 *                                    (optional) LLM planner
 *
 * Scoring is deterministic and reproducible; no stage below `plan actions` may
 * call an LLM, and no stage may execute anything itself — routing hands work to
 * BullMQ, which is the only executor.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** The staged-autonomy ladder. Order matters: each mode is a superset. */
export const INTELLIGENCE_MODES = [
  "off",
  "observe",
  "recommend",
  "route_safe",
  "route_llm",
  "full",
] as const;

export type IntelligenceMode = (typeof INTELLIGENCE_MODES)[number];

/** Rank of a mode on the ladder — higher means strictly more capability. */
export function modeRank(mode: IntelligenceMode): number {
  return INTELLIGENCE_MODES.indexOf(mode);
}

/** The deterministic signal vocabulary. Closed set. */
export const SIGNAL_TYPES = [
  "keyword_drop",
  "bad_lcp_high_exit",
  "citation_loss",
  "prospect_ready",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export type SignalSeverity = "info" | "warning" | "critical";

export interface Signal {
  clientId: string;
  signalType: SignalType;
  /** Deterministic over (clientId, signalType, subject). */
  fingerprint: string;
  severity: SignalSeverity;
  /** Keyword, page path, or platform. Redacted — never a full URL with query. */
  subject: string;
  /** Numeric evidence only. No source content, no secrets, no absolute paths. */
  evidence: Record<string, number | string | null>;
}

/** The deterministic opportunity vocabulary. Closed set. */
export const OPPORTUNITY_TYPES = [
  "recover_keyword_position",
  "fix_page_experience",
  "regain_answer_citation",
  "pursue_link_prospect",
] as const;

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export interface Opportunity {
  clientId: string;
  opportunityType: OpportunityType;
  /** Deterministic over the clustered signal fingerprints. */
  fingerprint: string;
  score: number;
  impact: number;
  confidence: number;
  effort: number;
  risk: number;
  signalFingerprints: string[];
  rationale: string;
}

/**
 * One planned action. Produced either deterministically from an opportunity
 * type or by the LLM planner — in both cases it is validated against the
 * closed intelligence action vocabulary before it can be routed.
 */
export interface PlannedAction {
  clientId: string;
  opportunityFingerprint: string;
  /** Must be a member of INTELLIGENCE_ACTIONS. */
  action: string;
  rationale: string;
  source: "deterministic" | "llm";
}

/** The result of putting a planned action through the policy gate. */
export interface GateVerdict {
  allowed: boolean;
  /** Present when `allowed` is false — the specific gate that refused. */
  reason?: string;
  /** The gate that decided, for audit. */
  gate?: string;
}

/** Where a routed action was sent, and under what job id. */
export interface RoutedJob {
  jobName: string;
  /** Deterministic — routing the same opportunity twice yields one queued job. */
  jobId: string;
}

/**
 * The minimal scheduler surface the router needs. Declared here so unit tests
 * can pass a fake and never touch Redis.
 */
export interface JobSink {
  addJob(jobName: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<void>;
}
