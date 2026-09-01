/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Policy Gate
 *
 * The single choke point between "the loop decided something" and "the loop
 * does something". Every routed action passes through `evaluateIntelligenceAction`.
 *
 * DESIGN: DENY-BY-DEFAULT, ALL REASONS COLLECTED.
 *
 * The gate starts from "blocked" and requires a positive reason to allow — so a
 * new action type added without a gate rule is denied, not permitted. And it
 * evaluates EVERY rule rather than returning on the first failure: an operator
 * debugging why an action did not run needs all of the reasons, not whichever
 * check happened to be ordered first. Short-circuiting here has cost real
 * debugging time in autonomous systems; the checks are pure and cheap, so there
 * is nothing to gain by stopping early.
 *
 * The gate does NOT consult an LLM and cannot be influenced by one. Its inputs
 * are config, client state, and the action vocabulary.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  classifyIntelligenceAction,
  INTELLIGENCE_ACTIONS,
  type RiskLevel,
} from "../../core/execution-policy.js";
import { createModuleLogger } from "../../core/logger.js";
import type { IntelligenceMode, ModeCapabilities } from "./modes.js";

const logger = createModuleLogger("intelligence:policy-gate");

/** Actions that enqueue outreach to a third party. */
const OUTREACH_ACTIONS = new Set(["intelligence_queue_outreach"]);

/** Actions that mutate the live site. */
const SITE_MUTATION_ACTIONS = new Set(["intelligence_execute_site_change"]);

/** Actions that only propose/record and never enqueue downstream work. */
const PROPOSAL_ONLY_ACTIONS = new Set([
  "intelligence_signal_only",
  "intelligence_generate_recommendation",
]);

export interface PolicyGateInput {
  clientId: string | undefined | null;
  action: string;
  mode: IntelligenceMode;
  capabilities: ModeCapabilities;
  client: { id: string; active: boolean } | null;
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
  /** True when this decision requires the LLM planner. */
  requiresLlm?: boolean;
}

export interface PolicyGateDecision {
  allowed: boolean;
  /** Every rule that blocked, not just the first. */
  reasons: string[];
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

/**
 * A missing clientId is a programming error, not a policy denial.
 *
 * Returning `{allowed:false}` here would be wrong: the caller would log a
 * routine block and carry on, when in fact a query somewhere above is about to
 * run unscoped across every tenant. This throws so the run fails and the
 * intelligence_runs row records an error.
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

  // ── Vocabulary: unknown actions fail closed ───────────────────────────────
  const isKnownAction = INTELLIGENCE_ACTIONS.includes(input.action);
  const { riskLevel } = classifyIntelligenceAction(input.action);
  if (!isKnownAction) {
    reasons.push(
      `action "${input.action}" is not in the intelligence vocabulary (fails closed to critical/approval)`,
    );
  }

  // ── Mode ──────────────────────────────────────────────────────────────────
  if (input.mode === "off") {
    reasons.push("INTELLIGENCE_MODE=off");
  }

  // ── Client state ──────────────────────────────────────────────────────────
  if (!input.client) {
    reasons.push(`client ${clientId} not found`);
  } else if (!input.client.active) {
    reasons.push(`client ${clientId} is inactive`);
  }

  // ── LLM budget ────────────────────────────────────────────────────────────
  if (input.requiresLlm) {
    if (!input.capabilities.usesLlmPlanner) {
      reasons.push(
        "LLM planning not permitted in this mode / INTELLIGENCE_LLM_PLANNING_ENABLED=false",
      );
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
    if (!input.capabilities.routesOutreach) {
      reasons.push(
        "outreach routing not permitted in this mode / INTELLIGENCE_ALLOW_OUTREACH_ROUTING=false",
      );
    }
    if (input.outreachVelocityExhausted) {
      reasons.push("outreach velocity allowance exhausted for this client");
    }
    // The ranking circuit breaker exists because autonomous content and
    // outreach are exactly what makes a ranking slide worse. When it is open,
    // the loop stops acting on the site's behalf entirely.
    if (input.rankingCircuitBreakerOpen) {
      reasons.push("ranking circuit breaker is open — autonomous outreach suspended");
    }
  } else if (isSiteMutation) {
    if (!input.capabilities.routesSiteMutation) {
      reasons.push(
        "site mutation not permitted in this mode / INTELLIGENCE_ALLOW_SITE_MUTATION=false",
      );
    }
    if (!input.siteDeploymentReady) {
      reasons.push("client site_deployment config is not ready");
    }
    if (input.siteDeployDryRun) {
      reasons.push("SITE_DEPLOY_DRY_RUN is active — live mutation blocked");
    }
    if (input.rankingCircuitBreakerOpen) {
      reasons.push("ranking circuit breaker is open — autonomous site changes suspended");
    }
  } else if (isProposalOnly) {
    if (!input.capabilities.writesProposals) {
      reasons.push("proposal writing not permitted in this mode");
    }
  } else {
    // Everything else routes a safe, read-only analysis job.
    if (!input.capabilities.routesSafeJobs) {
      reasons.push(
        "safe job routing not permitted in this mode / INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING=false",
      );
    }
  }

  // A critical action is never auto-allowed by this gate, whatever the mode.
  const requiresApproval = riskLevel === "critical";
  if (requiresApproval) {
    reasons.push(`action classified ${riskLevel} — operator approval required`);
  }

  const allowed = reasons.length === 0;

  if (!allowed) {
    logger.info(
      { clientId, action: input.action, mode: input.mode, reasons },
      "Intelligence action blocked",
    );
  }

  return { allowed, reasons, riskLevel, requiresApproval };
}
