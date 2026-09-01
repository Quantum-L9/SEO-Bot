/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Policy Gate
 *
 * The single choke point between "the loop decided something" and "the loop
 * does something". Every routed action passes through
 * `evaluateIntelligenceAction`.
 *
 * DENY BY DEFAULT, AND COLLECT EVERY REASON.
 *
 * The gate starts from "blocked" and requires a positive reason to allow, so an
 * action type added without a matching rule falls through to the safe-job
 * branch and is denied unless routing is on. And it evaluates EVERY rule rather
 * than returning on the first failure: an operator debugging why an action did
 * not run needs all the reasons, not whichever check happened to be ordered
 * first. Short-circuiting here costs real debugging time; the checks are pure
 * and cheap, so there is nothing to gain by stopping early.
 *
 * THE DANGEROUS ACTIONS ARE GATED ON STATE, NOT ON CONFIG.
 * Outreach is gated on the link-velocity governor and the ranking circuit
 * breaker. Site mutation is gated on deployment readiness, the dry-run switch,
 * and — through execution-policy — a CRITICAL classification that always
 * requires operator approval. A `.env` boolean says what someone intended weeks
 * ago; the governors say whether acting right now is safe.
 *
 * The gate consults no LLM and cannot be influenced by one.
 */

import {
  classifyIntelligenceAction,
  INTELLIGENCE_ACTIONS,
  type RiskLevel,
} from "../../core/execution-policy.js";
import { createModuleLogger } from "../../core/logger.js";
import type { IntelligenceCapabilities } from "./capabilities.js";

const logger = createModuleLogger("intelligence:policy-gate");

/** Actions that enqueue outreach to a third party. */
const OUTREACH_ACTIONS = new Set(["intelligence_queue_outreach"]);

/** Actions that mutate the live site. */
const SITE_MUTATION_ACTIONS = new Set(["intelligence_execute_site_change"]);

/** Actions that only propose/record and never enqueue downstream work. */
const PROPOSAL_ONLY_ACTIONS = new Set([
  "intelligence_signal_only",
  "intelligence_generate_recommendation",
  "intelligence_escalate_operator",
]);

export interface PolicyGateInput {
  clientId: string | undefined | null;
  action: string;
  capabilities: IntelligenceCapabilities;
  client: { id: string; active: boolean } | null;
  /** Opportunity score, checked against INTELLIGENCE_MIN_SCORE_TO_PLAN. */
  score?: number;
  /** True when the LLM router reports the daily spend cap reached. */
  llmBudgetExhausted?: boolean;
  /** True when the ranking circuit breaker has tripped for this client. */
  rankingCircuitBreakerOpen?: boolean;
  /** True when this client's outreach velocity allowance is spent. */
  outreachVelocityExhausted?: boolean;
  /** True when the client's site_deployment config is complete and live-capable. */
  siteDeploymentReady?: boolean;
  /** True when site deployment is forced to dry-run. */
  siteDeployDryRun?: boolean;
  /** True when an equivalent action is already pending for this opportunity. */
  duplicateActionPending?: boolean;
  /** True when a measurement window is already open for this target. */
  measurementWindowActive?: boolean;
  /** True when this decision requires the LLM planner. */
  requiresLlm?: boolean;
}

export interface PolicyGateDecision {
  allowed: boolean;
  /** Every rule that blocked, not just the first. */
  reasons: string[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  /** Machine-readable record of what the gate checked, for the decision ledger. */
  policyBasis: Record<string, unknown>;
}

/**
 * A missing clientId is a programming error, not a policy denial.
 *
 * Returning `{allowed:false}` would let the caller log a routine block and carry
 * on, when in fact a query somewhere above is about to run unscoped across every
 * tenant. This throws so the run fails and intelligence_runs records an error.
 */
export function requireClientId(clientId: string | undefined | null): string {
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error("intelligence policy gate: clientId is required");
  }
  return clientId;
}

export function evaluateIntelligenceAction(input: PolicyGateInput): PolicyGateDecision {
  const clientId = requireClientId(input.clientId);
  const reasons: string[] = [];
  const caps = input.capabilities;

  // ── Vocabulary: unknown actions fail closed ───────────────────────────────
  const isKnownAction = INTELLIGENCE_ACTIONS.includes(input.action);
  const { riskLevel } = classifyIntelligenceAction(input.action);
  if (!isKnownAction) {
    reasons.push(
      `action "${input.action}" is not in the intelligence vocabulary (fails closed to critical/approval)`,
    );
  }

  // ── Master switch ─────────────────────────────────────────────────────────
  if (!caps.enabled) reasons.push("INTELLIGENCE_ENABLED=false");

  // ── Client state ──────────────────────────────────────────────────────────
  if (!input.client) {
    reasons.push(`client ${clientId} not found`);
  } else if (!input.client.active) {
    reasons.push(`client ${clientId} is inactive`);
  }

  // ── Score threshold ───────────────────────────────────────────────────────
  if (typeof input.score === "number" && input.score < caps.minScoreToPlan) {
    reasons.push(
      `opportunity score ${input.score} is below INTELLIGENCE_MIN_SCORE_TO_PLAN (${caps.minScoreToPlan})`,
    );
  }

  // ── Duplicate / in-flight suppression ─────────────────────────────────────
  if (input.duplicateActionPending) {
    reasons.push("an equivalent action is already pending for this opportunity");
  }
  if (input.measurementWindowActive) {
    // Acting again mid-window destroys the attribution: the second action's
    // effect is indistinguishable from the first's.
    reasons.push("a measurement window is already open for this target");
  }

  // ── LLM budget ────────────────────────────────────────────────────────────
  if (input.requiresLlm) {
    if (!caps.usesLlmPlanner) {
      reasons.push("INTELLIGENCE_LLM_PLANNING_ENABLED=false");
    }
    if (input.llmBudgetExhausted) {
      reasons.push("LLM daily spend cap reached");
    }
  }

  // ── Per-action capability ─────────────────────────────────────────────────
  const isOutreach = OUTREACH_ACTIONS.has(input.action);
  const isSiteMutation = SITE_MUTATION_ACTIONS.has(input.action);
  const isProposalOnly = PROPOSAL_ONLY_ACTIONS.has(input.action);

  if (isOutreach) {
    if (input.outreachVelocityExhausted) {
      reasons.push("outreach velocity allowance exhausted for this client");
    }
    // Autonomous outreach is exactly what makes a ranking slide worse. When the
    // breaker is open the loop stops acting on the site's behalf entirely.
    if (input.rankingCircuitBreakerOpen) {
      reasons.push("ranking circuit breaker is open - autonomous outreach suspended");
    }
  } else if (isSiteMutation) {
    if (!input.siteDeploymentReady) {
      reasons.push("client site_deployment config is not ready");
    }
    if (input.siteDeployDryRun) {
      reasons.push("SITE_DEPLOY_DRY_RUN is active - live mutation blocked");
    }
    if (input.rankingCircuitBreakerOpen) {
      reasons.push("ranking circuit breaker is open - autonomous site changes suspended");
    }
  } else if (!isProposalOnly) {
    // Everything else routes a read-only analysis job.
    if (!caps.autoRouteLowRisk) {
      reasons.push("INTELLIGENCE_AUTO_ROUTE_LOW_RISK=false");
    }
  }

  // A critical action is never auto-allowed by this gate, whatever the config.
  const requiresApproval = riskLevel === "critical";
  if (requiresApproval) {
    reasons.push(`action classified ${riskLevel} - operator approval required`);
  }

  const allowed = reasons.length === 0;

  const policyBasis: Record<string, unknown> = {
    action: input.action,
    riskLevel,
    knownAction: isKnownAction,
    enabled: caps.enabled,
    autoRouteLowRisk: caps.autoRouteLowRisk,
    usesLlmPlanner: caps.usesLlmPlanner,
    minScoreToPlan: caps.minScoreToPlan,
    score: input.score ?? null,
    clientActive: input.client?.active ?? null,
    outreachVelocityExhausted: input.outreachVelocityExhausted ?? null,
    rankingCircuitBreakerOpen: input.rankingCircuitBreakerOpen ?? null,
    siteDeploymentReady: input.siteDeploymentReady ?? null,
    siteDeployDryRun: input.siteDeployDryRun ?? null,
    duplicateActionPending: input.duplicateActionPending ?? null,
    measurementWindowActive: input.measurementWindowActive ?? null,
  };

  if (!allowed) {
    logger.info({ clientId, action: input.action, reasons }, "Intelligence action blocked");
  }

  return { allowed, reasons, riskLevel, requiresApproval, policyBasis };
}
