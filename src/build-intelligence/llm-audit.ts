/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LLM router audit for the REDESIGN_IMPROVE seam.
 *
 * Build-intelligence LLM calls are recorded on the run recorder by the direct
 * DeepSeek client. This module projects those recorded calls into per-operation
 * records for the three governed operations (SEO_CONTENT_BLUEPRINT,
 * STRUCTURED_CONTENT_GENERATION, CONTENT_VALIDATION).
 *
 * Classification is by the governed decision ids the LlmService recorded when
 * it dispatched each call — NOT by the decision's `taskType`. Those task types
 * are not unique to these three producers: `generateContent()` also emits
 * TaskType.CONTENT_GENERATION and `score()` also emits TaskType.SCORING,
 * and on a long-running process that unrelated daemon traffic would otherwise
 * be reported as governed build-intelligence calls, carrying task-default
 * search policy into the audit.
 *
 * `direct_provider_bypass_count` is the number of bypass events the run recorder
 * stored for the same client. Calls that never entered the recorder, including
 * unrelated daemon traffic, are not part of this projection.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

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

export interface RecordedAuditCall {
  operation: string;
  task_id: string;
  client_id: string;
  timestamp: string;
  search_required: boolean;
  search_policy_source: string;
  outcome?: "SUCCESS" | "FAILED";
}

function isAuditOperation(operation: string): operation is LlmAuditOperation {
  return (LLM_AUDIT_OPERATIONS as readonly string[]).includes(operation);
}

function searchPolicy(value: string): LlmAuditCallRecord["search_policy_source"] {
  return value === "EXPLICIT" ? "EXPLICIT" : "TASK_DEFAULT";
}

/**
 * Project recorded DeepSeek calls into the audit. `calls` are the run recorder's
 * operations, already scoped by the caller when a client was requested.
 * `directProviderBypassCount` is that same client's measured bypass events.
 */
export function projectLlmAudit(input: {
  calls: readonly RecordedAuditCall[];
  directProviderBypassCount: number;
}): LlmAuditProjection {
  const projection = emptyAuditProjection();
  for (const call of input.calls) {
    if (!isAuditOperation(call.operation)) continue;
    projection.operations[call.operation].push({
      operation: call.operation,
      task_id: call.task_id,
      client_id: call.client_id,
      timestamp: call.timestamp,
      search_required: call.search_required,
      search_policy_source: searchPolicy(call.search_policy_source),
      outcome: call.outcome,
    });
  }
  projection.direct_provider_bypass_count = input.directProviderBypassCount;
  projection.produced_at = new Date().toISOString();
  return projection;
}
