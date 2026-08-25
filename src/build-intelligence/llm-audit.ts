/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM router audit for the REDESIGN_IMPROVE seam.
 *
 * Every SEO-Bot LLM call for the build-intelligence transaction routes through
 * @quantum-l9/llm-router (LlmService.execute → router.execute), so the router's
 * own call log is the audit authority. This module projects `getCallLog()`
 * RoutingDecision entries into per-operation records for the three governed
 * operations (SEO_CONTENT_BLUEPRINT, STRUCTURED_CONTENT_GENERATION,
 * CONTENT_VALIDATION), classified by the decision's `taskType` — those task
 * types are produced by exactly these three producers and nothing else in the
 * bot (verify: grep for TaskType. use in src/).
 *
 * `direct_provider_bypass_count` is MEASURED, not asserted: the LlmService
 * counts every executePolicyJson invocation it was asked to run, and the audit
 * compares that against the decisions actually logged by the router. A missing
 * logged decision means a call that bypassed the router.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { type RoutingDecision, SearchPolicySource, TaskType } from "@quantum-l9/llm-router";
import type { LlmService } from "../services/llm.js";

export const LLM_AUDIT_OPERATIONS = [
  "SEO_CONTENT_BLUEPRINT",
  "STRUCTURED_CONTENT_GENERATION",
  "CONTENT_VALIDATION",
] as const;
export type LlmAuditOperation = (typeof LLM_AUDIT_OPERATIONS)[number];

/** A normalized search-policy value (uppercase) — the oracle pins "EXPLICIT". */
export type LlmAuditSearchPolicySource = "EXPLICIT" | "TASK_DEFAULT";

export interface LlmAuditCallRecord {
  operation: LlmAuditOperation;
  task_id: string;
  client_id: string;
  timestamp: string;
  /** Must be false: these operations consume normalized evidence, no search. */
  search_required: boolean;
  /**
   * Must be "EXPLICIT": `requiresSearch: false` is set explicitly in
   * SEO_IMPROVE_LLM_POLICY, never inherited from a TaskType default.
   */
  search_policy_source: LlmAuditSearchPolicySource;
  outcome?: "SUCCESS" | "FAILED";
  failure_kind?: string;
  error_code?: string;
}

export interface LlmAuditProjection {
  produced_at: string;
  operations: Record<LlmAuditOperation, LlmAuditCallRecord[]>;
  direct_provider_bypass_count: number;
}

/** The only producers that may create these task types (verified by grep). */
const OPERATION_TASK_TYPES: Record<LlmAuditOperation, TaskType> = {
  SEO_CONTENT_BLUEPRINT: TaskType.STRATEGIC_REASONING,
  STRUCTURED_CONTENT_GENERATION: TaskType.CONTENT_GENERATION,
  CONTENT_VALIDATION: TaskType.SCORING,
};

export function emptyAuditProjection(): LlmAuditProjection {
  return {
    produced_at: new Date().toISOString(),
    operations: {
      SEO_CONTENT_BLUEPRINT: [],
      STRUCTURED_CONTENT_GENERATION: [],
      CONTENT_VALIDATION: [],
    },
    direct_provider_bypass_count: 0,
  };
}

function toCallRecord(decision: RoutingDecision): LlmAuditCallRecord | null {
  for (const [operation, taskType] of Object.entries(OPERATION_TASK_TYPES) as Array<
    [LlmAuditOperation, TaskType]
  >) {
    if (decision.taskType !== taskType) continue;
    return {
      operation,
      task_id: decision.taskId,
      client_id: decision.clientId,
      timestamp: decision.timestamp,
      search_required: decision.searchRequired,
      search_policy_source:
        decision.searchPolicySource === SearchPolicySource.EXPLICIT ? "EXPLICIT" : "TASK_DEFAULT",
      outcome: decision.outcome,
      failure_kind: decision.failureKind,
      error_code: decision.errorCode,
    };
  }
  return null;
}

/**
 * Project the router's call log into the audit for the three governed
 * operations. Optionally scoped to one client_id. `direct_provider_bypass_count`
 * is the number of executePolicyJson invocations the LlmService was asked to
 * run for these operations that have NO logged router decision.
 */
export function projectLlmAudit(
  llm: LlmService,
  options: { clientId?: string } = {},
): LlmAuditProjection {
  const projection = emptyAuditProjection();
  const decisions = llm.getRouter().getCallLog(Number.MAX_SAFE_INTEGER);
  for (const decision of decisions) {
    if (options.clientId && decision.clientId !== options.clientId) continue;
    const record = toCallRecord(decision);
    if (record) projection.operations[record.operation].push(record);
  }

  const expected = llm.getPolicyCallCounts();
  let bypass = 0;
  for (const operation of LLM_AUDIT_OPERATIONS) {
    const logged = projection.operations[operation].length;
    bypass += Math.max(0, (expected[operation] ?? 0) - logged);
  }
  projection.direct_provider_bypass_count = bypass;
  projection.produced_at = new Date().toISOString();
  return projection;
}
