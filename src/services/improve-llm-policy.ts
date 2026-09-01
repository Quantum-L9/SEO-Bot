import { TaskComplexity, type TaskDescriptor, TaskType } from "@quantum-l9/llm-router";

/**
 * SEO-Bot's LLM operations for the REDESIGN_IMPROVE seam.
 *
 * The application declares *capability* (task type, complexity, whether search
 * is required); provider/model selection belongs entirely to LLM-Router.
 *
 * CompetitiveLandscape is intentionally absent: SERP ranking/aggregation is
 * deterministic DataForSEO work, not an LLM task.
 */
export type SeoImproveLlmOperation =
  | "SEO_GAP_EXTRACTION"
  | "SEO_CONTENT_BLUEPRINT"
  | "STRUCTURED_CONTENT_GENERATION"
  | "CONTENT_VALIDATION"
  | "FRESH_WEB_EVIDENCE"
  /**
   * Intelligence plane (ADR-0016, contract C2): rank the actions an evidence
   * pack already permits. SCORING, not generation — the model chooses among a
   * fixed allow-list and never authors an action name.
   */
  | "INTELLIGENCE_ACTION_SELECTION";

type PolicyEntry = Omit<TaskDescriptor, "clientId" | "description">;

export const SEO_IMPROVE_LLM_POLICY: Record<SeoImproveLlmOperation, PolicyEntry> = {
  SEO_GAP_EXTRACTION: {
    type: TaskType.EXTRACTION,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 3500,
    requiresReasoning: true,
    requiresSearch: false,
  },
  SEO_CONTENT_BLUEPRINT: {
    type: TaskType.STRATEGIC_REASONING,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 5000,
    requiresReasoning: true,
    requiresSearch: false,
  },
  STRUCTURED_CONTENT_GENERATION: {
    type: TaskType.CONTENT_GENERATION,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 7000,
    requiresReasoning: true,
    requiresSearch: false,
  },
  CONTENT_VALIDATION: {
    type: TaskType.SCORING,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 2500,
    requiresReasoning: true,
    requiresSearch: false,
  },
  FRESH_WEB_EVIDENCE: {
    type: TaskType.MARKET_RESEARCH,
    complexity: TaskComplexity.MEDIUM,
    expectedOutputTokens: 2500,
    requiresReasoning: false,
    requiresSearch: true,
  },
  // Small on purpose. The input is one redacted evidence pack and the output is
  // a ranking of at most a handful of allow-listed action strings, so a large
  // output budget here would only buy prose nobody reads.
  INTELLIGENCE_ACTION_SELECTION: {
    type: TaskType.SCORING,
    complexity: TaskComplexity.MEDIUM,
    expectedOutputTokens: 1200,
    requiresReasoning: true,
    requiresSearch: false,
  },
};

export function seoImproveTask(
  operation: SeoImproveLlmOperation,
  clientId: string,
  description: string,
): TaskDescriptor {
  return {
    ...SEO_IMPROVE_LLM_POLICY[operation],
    clientId,
    description,
  };
}

/**
 * Fail-closed invariant guard: the reasoning operations must consume normalized
 * evidence (requiresSearch:false); only FRESH_WEB_EVIDENCE may request search.
 */
export function assertSeoImprovePolicy(): void {
  const forbiddenSearchOperations: SeoImproveLlmOperation[] = [
    "SEO_GAP_EXTRACTION",
    "SEO_CONTENT_BLUEPRINT",
    "STRUCTURED_CONTENT_GENERATION",
    "CONTENT_VALIDATION",
    // The pack IS the evidence. A search provider here would let the model
    // reason from the open web about a client it is deliberately not told the
    // identity of — which is both a worse decision and a redaction leak.
    "INTELLIGENCE_ACTION_SELECTION",
  ];

  for (const operation of forbiddenSearchOperations) {
    const descriptor = SEO_IMPROVE_LLM_POLICY[operation];
    if (descriptor.requiresSearch !== false) {
      throw new Error(
        `LLM_POLICY_VIOLATION: ${operation} must use normalized evidence and reasoning, not a search provider.`,
      );
    }
  }

  if (SEO_IMPROVE_LLM_POLICY.FRESH_WEB_EVIDENCE.requiresSearch !== true) {
    throw new Error("LLM_POLICY_VIOLATION: FRESH_WEB_EVIDENCE must explicitly request search.");
  }
}
