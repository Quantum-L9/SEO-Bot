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
 * CONTENT_VALIDATION).
 *
 * Classification is by the governed decision ids the LlmService recorded when
 * it dispatched each call — NOT by the decision's `taskType`. Those task types
 * are not unique to these three producers: `generateContent()` also emits
 * TaskType.CONTENT_GENERATION and `score()` also emits TaskType.SCORING,
 * and on a long-running process that unrelated daemon traffic would otherwise
 * be reported as governed build-intelligence calls, carrying task-default
 * search policy into the audit.
 *
 * `direct_provider_bypass_count` is MEASURED, not asserted: the LlmService
 * counts every executePolicyJson invocation it was asked to run, and the audit
 * compares that against the decisions actually logged by the router. A missing
 * logged decision means a call that bypassed the router. Both sides of that
 * comparison are scoped to the same client, so a per-tenant query never
 * measures one client's logged calls against another client's expected count.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { type RoutingDecision, SearchPolicySource } from "@quantum-l9/llm-router";
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

function toCallRecord(operation: LlmAuditOperation, decision: RoutingDecision): LlmAuditCallRecord {
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
  // Governed decision ids recorded at dispatch — the authority for "was this
  // router decision one of ours?". Scoped to the same client as the counts
  // below, so both sides of the bypass comparison describe one tenant.
  const governed = llm.getGovernedDecisionIds(options.clientId);
  const operationOf = new Map<string, LlmAuditOperation>();
  for (const operation of LLM_AUDIT_OPERATIONS) {
    for (const taskId of governed.get(operation) ?? []) operationOf.set(taskId, operation);
  }

  const decisions = llm.getRouter().getCallLog(Number.MAX_SAFE_INTEGER);
  for (const decision of decisions) {
    if (options.clientId && decision.clientId !== options.clientId) continue;
    const operation = operationOf.get(decision.taskId);
    if (!operation) continue;
    projection.operations[operation].push(toCallRecord(operation, decision));
  }

  const expected = llm.getPolicyCallCounts(options.clientId);
  let bypass = 0;
  for (const operation of LLM_AUDIT_OPERATIONS) {
    const logged = projection.operations[operation].length;
    bypass += Math.max(0, (expected[operation] ?? 0) - logged);
  }
  projection.direct_provider_bypass_count = bypass;
  projection.produced_at = new Date().toISOString();
  return projection;
}
