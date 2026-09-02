/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Action Planner (ADR-0016)
 *
 * Turns a scored opportunity into a decision, and — only when policy allows —
 * into a proposal for the EXISTING execution policy plus a job on the EXISTING
 * module allow-list.
 *
 * What this module deliberately cannot do:
 *   - write to a client site (that is site-deployment, gated by AGENTS §9);
 *   - execute an action (that is the execution policy's call, then the worker's);
 *   - reach a job outside `TRIGGERABLE_JOBS` (which excludes the live-write job);
 *   - invent an action string (every template action must appear in the
 *     evidence pack's allow-list, asserted at import).
 *
 * Pure. The runner performs the writes; keeping the choosing separate from the
 * doing is what makes "which action, and why" testable without a database.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  type ActionProposal,
  createProposal,
  type ExecutionDecision,
  evaluateExecution,
} from "../core/execution-policy.js";
import { isTriggerableJob } from "../core/scheduler.js";
import { allowedActionsFor, FORBIDDEN_ACTIONS } from "./evidence-pack.js";
import {
  evaluatePolicy,
  type PolicyContext,
  type PolicyState,
  type PolicyVerdict,
} from "./policy-engine.js";
import type { OpportunityType, ScoredOpportunity } from "./types.js";

export interface PlanTemplate {
  /** Key in the execution policy's action taxonomy. */
  readonly action: string;
  /** Owning module, recorded on the action log row. */
  readonly module: string;
  /** Follow-up job to queue, or null when the decision needs no new data. */
  readonly followUpJob: string | null;
  readonly requiresLlm: boolean;
  readonly isOutreach: boolean;
  readonly hypothesis: string;
  /** Metric an experiment measures once this action has been executed. */
  readonly targetMetric: "serp_position" | "page_exit_rate" | "aeo_citation_rate";
}

/**
 * One template per actionable opportunity type. `budget_review` and
 * `pipeline_repair` are intentionally absent: their remedy is operator
 * attention, not a site change, and the policy engine routes them to
 * `run_diagnostic` before they ever reach here.
 */
export const PLAN_TEMPLATES: Readonly<Partial<Record<OpportunityType, PlanTemplate>>> = {
  keyword_drop_plus_page_experience: {
    action: "faq_content_add",
    module: "serp-intelligence",
    followUpJob: "serp:generate-surpass-plan",
    requiresLlm: true,
    isOutreach: false,
    hypothesis:
      "Answering the query above the fold and fixing load time recovers the lost position.",
    targetMetric: "serp_position",
  },
  serp_and_answer_engine_loss: {
    action: "schema_markup_injection",
    module: "aeo-geo",
    followUpJob: "aeo:optimize-faqs",
    requiresLlm: true,
    isOutreach: false,
    hypothesis:
      "Structured answers and FAQ schema restore answer-engine citation and organic position.",
    targetMetric: "aeo_citation_rate",
  },
  keyword_recovery: {
    action: "meta_title_update",
    module: "serp-intelligence",
    followUpJob: "serp:competitor-analysis",
    requiresLlm: true,
    isOutreach: false,
    hypothesis: "Tightening title and internal links recovers the lost position.",
    targetMetric: "serp_position",
  },
  page_experience_repair: {
    action: "page_speed_optimization",
    module: "web-vitals",
    followUpJob: "vitals:check-all-sources",
    requiresLlm: false,
    isOutreach: false,
    hypothesis: "Reducing LCP lowers the exit rate on this page.",
    targetMetric: "page_exit_rate",
  },
  performance_regression: {
    action: "page_speed_optimization",
    module: "web-vitals",
    followUpJob: "vitals:check-all-sources",
    requiresLlm: false,
    isOutreach: false,
    hypothesis: "Restoring LCP to its prior baseline holds engagement steady.",
    targetMetric: "page_exit_rate",
  },
  answer_engine_gap: {
    action: "faq_content_add",
    module: "aeo-geo",
    followUpJob: "aeo:optimize-faqs",
    requiresLlm: true,
    isOutreach: false,
    hypothesis: "A direct answer block raises the citation rate on this platform.",
    targetMetric: "aeo_citation_rate",
  },
  link_outreach_batch: {
    action: "outreach_email_send",
    module: "link-building",
    followUpJob: "links:process-outreach",
    requiresLlm: true,
    isOutreach: true,
    hypothesis: "Contacting high-authority prospects converts some into referring domains.",
    targetMetric: "serp_position",
  },
};

export function planTemplateFor(opportunityType: OpportunityType): PlanTemplate | null {
  return PLAN_TEMPLATES[opportunityType] ?? null;
}

export interface PlannedDecision {
  readonly opportunity: ScoredOpportunity;
  readonly verdict: PolicyVerdict;
  readonly template: PlanTemplate | null;
  /** Present only when the verdict is `propose_action` and a template exists. */
  readonly proposal: ActionProposal | null;
  /** The EXISTING execution policy's call on that proposal. */
  readonly execution: ExecutionDecision | null;
}

export interface PlanInputs {
  readonly policyState: PolicyState;
  readonly clientActive: boolean;
  readonly minScore: number;
  readonly maxActionsPerRun: number;
  readonly actionsTakenThisRun: number;
  readonly openFingerprints: ReadonlySet<string>;
}

/**
 * Decide what to do about one opportunity.
 *
 * The policy engine gates first (governors, thresholds, budget); the execution
 * policy then decides autonomy versus approval. Both gates run — this plane
 * narrows what reaches the second one and never bypasses it.
 */
export function planOpportunity(
  opportunity: ScoredOpportunity,
  inputs: PlanInputs,
): PlannedDecision {
  const template = planTemplateFor(opportunity.opportunityType);

  const context: PolicyContext = {
    clientActive: inputs.clientActive,
    opportunityType: opportunity.opportunityType,
    opportunityScore: opportunity.score,
    minScore: inputs.minScore,
    requiresLlm: template?.requiresLlm ?? false,
    isOutreach: template?.isOutreach ?? false,
    duplicateOfOpenWork: inputs.openFingerprints.has(opportunity.fingerprint),
    actionsTakenThisRun: inputs.actionsTakenThisRun,
    maxActionsPerRun: inputs.maxActionsPerRun,
  };

  const verdict = evaluatePolicy(inputs.policyState, context);

  if (verdict.decision !== "propose_action" || !template) {
    return { opportunity, verdict, template, proposal: null, execution: null };
  }

  const proposal = createProposal({
    clientId: opportunity.clientId,
    module: template.module,
    action: template.action,
    description: opportunity.description,
    rationale: `${verdict.rationale} ${template.hypothesis}`,
    triggeredBy: `intelligence:${opportunity.opportunityType}:${opportunity.fingerprint}`,
    estimatedImpact: impactBand(opportunity.score),
    aiRecommendation: template.hypothesis,
    aiConfidence: opportunity.confidence,
    metadata: {
      opportunity_type: opportunity.opportunityType,
      opportunity_fingerprint: opportunity.fingerprint,
      opportunity_score: opportunity.score,
      target_url: opportunity.targetUrl,
      target_keyword: opportunity.targetKeyword,
      signal_types: [...new Set(opportunity.signals.map((signal) => signal.signalType))].sort(),
    },
  });

  return { opportunity, verdict, template, proposal, execution: evaluateExecution(proposal) };
}

/** Coarse impact label for the operator dashboard's action log. */
export function impactBand(score: number): "high" | "medium" | "low" {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

// ─── Import-time invariants ──────────────────────────────────────────────────
//
// These are the two ways this module could silently gain reach it should not
// have: a template naming an action outside the evidence-pack allow-list, or a
// follow-up job outside the scheduler's trigger allow-list. Both fail at import.

for (const [opportunityType, template] of Object.entries(PLAN_TEMPLATES)) {
  if (!template) continue;

  const allowed = allowedActionsFor(opportunityType);
  if (!allowed.includes(template.action)) {
    throw new Error(
      `Action planner: "${template.action}" is not in the allowed actions for ${opportunityType} ` +
        `(${allowed.join(", ") || "none"})`,
    );
  }

  if (FORBIDDEN_ACTIONS.includes(template.action)) {
    throw new Error(`Action planner: "${template.action}" is a forbidden action`);
  }

  if (template.followUpJob !== null && !isTriggerableJob(template.followUpJob)) {
    throw new Error(
      `Action planner: follow-up job "${template.followUpJob}" for ${opportunityType} is not in ` +
        "the scheduler's TRIGGERABLE_JOBS allow-list",
    );
  }
}
