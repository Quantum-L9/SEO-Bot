/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Execution Policy Engine (v2.0 — Maximum Autonomy)
 *
 * Design philosophy: Execute everything autonomously EXCEPT structural changes
 * that affect >30% of the site or are irreversible AND high-risk.
 *
 * The operator enables daily backups. Worst case = rollback.
 * Only truly catastrophic, irreversible actions require human approval.
 *
 * Risk Classification:
 *   LOW      → Auto-execute. Always.
 *   MEDIUM   → Auto-execute. Always. (reversible OR irreversible)
 *   HIGH     → Auto-execute. (operator has backups, worst case = rollback)
 *   CRITICAL → ALWAYS queue for approval. (site redesign, strategy overhaul, bulk delete)
 *
 * Budget is handled by @quantum-l9/llm-router — this module only handles action approval.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "./database/index.js";
import { createModuleLogger } from "./logger.js";

const logger = createModuleLogger("execution-policy");

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ActionStatus =
  | "auto_executed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired";

export interface ActionProposal {
  clientId: string;
  module: string;
  action: string;
  description: string;
  rationale: string;
  triggeredBy: string; // e.g., "competitor:roofingpros.com overtook position #1"
  riskLevel: RiskLevel;
  reversible: boolean;
  options?: ActionOption[];
  aiRecommendation?: string;
  aiConfidence?: number; // 0-1
  estimatedImpact?: string;
  metadata?: Record<string, unknown>;
}

export interface ActionOption {
  id: string;
  label: string;
  description: string;
  riskLevel: RiskLevel;
  reversible: boolean;
  recommended: boolean;
  confidence: number;
}

export interface ExecutionDecision {
  execute: boolean;
  reason: string;
  requiresApproval: boolean;
}

// ═══════════════════════════════════════════════════════════════
// ACTION TAXONOMY — classified by risk
// ═══════════════════════════════════════════════════════════════

const ACTION_CLASSIFICATION: Record<string, { riskLevel: RiskLevel; reversible: boolean }> = {
  // LOW RISK — always auto-execute
  internal_link_adjustment: { riskLevel: "low", reversible: true },
  internal_link_add: { riskLevel: "low", reversible: true },
  meta_description_update: { riskLevel: "low", reversible: true },
  meta_title_update: { riskLevel: "low", reversible: true },
  schema_markup_injection: { riskLevel: "low", reversible: true },
  schema_markup_update: { riskLevel: "low", reversible: true },
  faq_content_update: { riskLevel: "low", reversible: true },
  faq_content_add: { riskLevel: "low", reversible: true },
  blog_post_draft: { riskLevel: "low", reversible: true },
  blog_post_publish: { riskLevel: "low", reversible: true },
  blog_post_update: { riskLevel: "low", reversible: true },
  citation_submission: { riskLevel: "low", reversible: false },
  image_alt_text_update: { riskLevel: "low", reversible: true },
  heading_optimization: { riskLevel: "low", reversible: true },
  sitemap_regenerate: { riskLevel: "low", reversible: true },
  canonical_tag_set: { riskLevel: "low", reversible: true },

  // MEDIUM RISK — auto-execute (operator has backups)
  title_tag_update: { riskLevel: "medium", reversible: true },
  content_rewrite: { riskLevel: "medium", reversible: true },
  cta_copy_rewrite: { riskLevel: "medium", reversible: true },
  page_content_rewrite: { riskLevel: "medium", reversible: true },
  nav_link_reposition: { riskLevel: "medium", reversible: true },
  outreach_email_send: { riskLevel: "medium", reversible: false },
  guest_post_pitch: { riskLevel: "medium", reversible: false },
  haro_response: { riskLevel: "medium", reversible: false },
  directory_submission: { riskLevel: "medium", reversible: false },
  content_syndication: { riskLevel: "medium", reversible: false },
  social_post_publish: { riskLevel: "medium", reversible: true },
  page_speed_optimization: { riskLevel: "medium", reversible: true },
  css_performance_fix: { riskLevel: "medium", reversible: true },
  competitor_surpass_execute: { riskLevel: "medium", reversible: true },
  page_priority_change: { riskLevel: "medium", reversible: true },
  robots_txt_update: { riskLevel: "medium", reversible: true },

  // HIGH RISK — auto-execute (operator has daily backups, worst case = rollback)
  url_slug_change: { riskLevel: "high", reversible: false },
  page_redirect_301: { riskLevel: "high", reversible: false },
  url_redirect: { riskLevel: "high", reversible: true },
  nav_item_remove: { riskLevel: "high", reversible: true },
  page_noindex_set: { riskLevel: "high", reversible: true },
  backlink_disavow: { riskLevel: "high", reversible: false },
  service_page_merge: { riskLevel: "high", reversible: false },
  page_removal_from_nav: { riskLevel: "high", reversible: true },
  disavow_link: { riskLevel: "high", reversible: false },
  page_deletion: { riskLevel: "high", reversible: false },

  // CRITICAL — ALWAYS requires approval (structural/catastrophic)
  site_redesign: { riskLevel: "critical", reversible: false },
  seo_strategy_overhaul: { riskLevel: "critical", reversible: false },
  domain_migration: { riskLevel: "critical", reversible: false },
  domain_change: { riskLevel: "critical", reversible: false },
  bulk_page_delete: { riskLevel: "critical", reversible: false },
  bulk_redirect_change: { riskLevel: "critical", reversible: false },
  hosting_migration: { riskLevel: "critical", reversible: false },
};

// ═══════════════════════════════════════════════════════════════
// INTELLIGENCE ACTION VOCABULARY — closed set, fail-closed
// ═══════════════════════════════════════════════════════════════

/**
 * The module whose proposals are classified against a CLOSED vocabulary.
 */
export const INTELLIGENCE_MODULE = "intelligence";

/**
 * Every action the intelligence control loop is permitted to propose.
 *
 * This is deliberately a separate, closed table rather than entries in
 * ACTION_CLASSIFICATION. The intelligence loop is the one caller whose action
 * strings can originate from an LLM, so it must not be able to reach into the
 * general taxonomy and name `page_deletion` or `content_rewrite` directly —
 * it routes work to the modules that own those actions instead.
 *
 * Anything not listed here — a typo, a new action nobody classified, or a
 * string an LLM invented — classifies CRITICAL and is held for approval.
 */
const INTELLIGENCE_ACTION_CLASSIFICATION: Record<
  string,
  { riskLevel: RiskLevel; reversible: boolean }
> = {
  // Observation only — records a signal, changes nothing.
  intelligence_signal_only: { riskLevel: "low", reversible: true },
  intelligence_generate_recommendation: { riskLevel: "low", reversible: true },
  // Safe analysis routing — enqueues a read-only analysis job.
  intelligence_run_competitor_analysis: { riskLevel: "low", reversible: true },
  intelligence_optimize_faq_draft: { riskLevel: "low", reversible: true },
  // Produces a plan; executing that plan is a separate, separately-gated step.
  intelligence_generate_surpass_plan: { riskLevel: "medium", reversible: true },
  intelligence_request_site_fix: { riskLevel: "medium", reversible: true },
  // Irreversible outward action. Classified high rather than critical because
  // reaching it already requires mode=full AND the outreach flag AND the link
  // velocity governor — the policy gate, not this table, is its real brake.
  intelligence_queue_outreach: { riskLevel: "high", reversible: false },
  // Mutates a live site. Always held for a human, in every mode.
  intelligence_execute_site_change: { riskLevel: "critical", reversible: false },
};

/**
 * The action names the intelligence loop may propose, for planner validation.
 */
export const INTELLIGENCE_ACTIONS = Object.freeze(
  Object.keys(INTELLIGENCE_ACTION_CLASSIFICATION),
) as readonly string[];

// ═══════════════════════════════════════════════════════════════
// DECISION ENGINE — MAXIMUM AUTONOMY
// ═══════════════════════════════════════════════════════════════

/**
 * Determines whether an action should be auto-executed or queued for approval.
 *
 * MAXIMUM AUTONOMY POLICY:
 * - LOW:     Always execute. No exceptions.
 * - MEDIUM:  Always execute. No exceptions. (even irreversible — outreach, submissions)
 * - HIGH:    Always execute. (operator has daily backups — worst case is rollback)
 * - CRITICAL: Queue for approval. Always. (site redesign, strategy overhaul, bulk delete)
 *
 * This is the only gate. Budget throttling is handled by @quantum-l9/llm-router.
 */
export function evaluateExecution(proposal: ActionProposal): ExecutionDecision {
  const { riskLevel } = proposal;

  // CRITICAL = the ONLY level that requires approval
  if (riskLevel === "critical") {
    return {
      execute: false,
      reason:
        `CRITICAL action requires operator approval: ${proposal.action}. ` +
        `This affects site structure at scale and cannot be safely rolled back.`,
      requiresApproval: true,
    };
  }

  // EVERYTHING ELSE: AUTO-EXECUTE
  return {
    execute: true,
    reason:
      `Auto-executing [${riskLevel}] action: ${proposal.action}. ` +
      `Rationale: ${proposal.rationale}`,
    requiresApproval: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Classifies an action string into risk level and reversibility.
 *
 * Two fallbacks, deliberately different:
 *
 * - For the intelligence module the vocabulary is CLOSED and the fallback is
 *   CRITICAL. Intelligence action strings can originate from an LLM, and an
 *   action nobody classified is an action nobody reasoned about, so it is held
 *   for a human rather than auto-executed. This is the seam that stops a
 *   planner from inventing its way into an unreviewed mutation.
 *
 * - For every other module the fallback stays medium/reversible. Those action
 *   strings are authored in code, not generated, so an unrecognised one is a
 *   naming drift rather than an injection, and the maximum-autonomy policy
 *   (operator holds daily backups) still applies.
 *
 * @param actionType the action string being classified
 * @param module     the proposing module; pass it to get the closed-vocabulary
 *                   treatment for intelligence proposals
 */
export function classifyAction(
  actionType: string,
  module?: string,
): { riskLevel: RiskLevel; reversible: boolean } {
  if (module === INTELLIGENCE_MODULE) {
    const intelClassification = INTELLIGENCE_ACTION_CLASSIFICATION[actionType];
    if (intelClassification) return intelClassification;

    // Fail closed. An unrecognised intelligence action is never auto-executed.
    logger.warn(
      { actionType, module },
      "Unknown INTELLIGENCE action type — failing closed to critical (requires approval)",
    );
    return { riskLevel: "critical", reversible: false };
  }

  const classification = ACTION_CLASSIFICATION[actionType];
  if (classification) return classification;

  // Unknown action → default to medium/reversible (auto-execute)
  logger.warn(
    { actionType },
    "Unknown action type — defaulting to medium/reversible (auto-execute)",
  );
  return { riskLevel: "medium", reversible: true };
}

/**
 * Create a fully-classified proposal from raw action data.
 */
export function createProposal(params: {
  clientId: string;
  module: string;
  action: string;
  description: string;
  rationale: string;
  triggeredBy: string;
  estimatedImpact?: string;
  options?: ActionOption[];
  aiRecommendation?: string;
  aiConfidence?: number;
  metadata?: Record<string, unknown>;
}): ActionProposal {
  // The module is part of the classification, not decoration: intelligence
  // proposals are classified against their own closed vocabulary and fail
  // closed on anything outside it.
  const { riskLevel, reversible } = classifyAction(params.action, params.module);

  return {
    ...params,
    riskLevel,
    reversible,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACTION LOG — persist all decisions for weekly report
// ═══════════════════════════════════════════════════════════════

/**
 * Log an action and its execution decision to the database.
 * Used by the weekly report to show "what was done and why."
 */
export async function logAction(
  proposal: ActionProposal,
  decision: ExecutionDecision,
): Promise<string> {
  const db = getDb();

  const [record] = await db
    .insert(schema.actionLog)
    .values({
      clientId: proposal.clientId,
      module: proposal.module,
      action: proposal.action,
      description: proposal.description,
      rationale: proposal.rationale,
      triggeredBy: proposal.triggeredBy,
      riskLevel: proposal.riskLevel,
      reversible: proposal.reversible,
      status: decision.execute ? "auto_executed" : "pending_approval",
      options: proposal.options ? JSON.stringify(proposal.options) : null,
      aiRecommendation: proposal.aiRecommendation,
      aiConfidence: proposal.aiConfidence,
      estimatedImpact: proposal.estimatedImpact ?? null,
      metadata: proposal.metadata || {},
    })
    .returning({ id: schema.actionLog.id });

  logger.info(
    {
      actionId: record.id,
      client: proposal.clientId,
      action: proposal.action,
      risk: proposal.riskLevel,
      reversible: proposal.reversible,
      autoExecuted: decision.execute,
      reason: decision.reason,
    },
    `Action ${decision.execute ? "auto-executed" : "queued for approval"}`,
  );

  return record.id;
}

// ═══════════════════════════════════════════════════════════════
// APPROVAL QUEUE — for operator dashboard
// ═══════════════════════════════════════════════════════════════

/**
 * Get all pending approval items (only CRITICAL actions end up here).
 */
export async function getPendingApprovals(clientId?: string): Promise<unknown[]> {
  const db = getDb();

  const conditions = [eq(schema.actionLog.status, "pending_approval")];

  if (clientId) {
    conditions.push(eq(schema.actionLog.clientId, clientId));
  }

  const rows = await db
    .select()
    .from(schema.actionLog)
    .where(and(...conditions))
    .orderBy(schema.actionLog.createdAt);

  return rows;
}

/**
 * Approve a pending action (called from operator dashboard).
 */
export async function approveAction(actionId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.actionLog)
    .set({ status: "approved", resolvedAt: new Date() })
    .where(eq(schema.actionLog.id, actionId));

  logger.info({ actionId }, "Action approved by operator — will execute on next cycle");
}

/**
 * Reject a pending action (called from operator dashboard).
 */
export async function rejectAction(actionId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.actionLog)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(eq(schema.actionLog.id, actionId));

  logger.info({ actionId }, "Action rejected by operator");
}
