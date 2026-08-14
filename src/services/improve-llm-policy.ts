import {
  TaskComplexity,
  TaskType,
  type TaskDescriptor,
} from '@quantum-l9/llm-router';

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
  | 'SEO_GAP_EXTRACTION'
  | 'SEO_CONTENT_BLUEPRINT'
  | 'STRUCTURED_CONTENT_GENERATION'
  | 'CONTENT_VALIDATION'
  | 'FRESH_WEB_EVIDENCE';

type PolicyEntry = Omit<TaskDescriptor, 'clientId' | 'description'>;

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
    'SEO_GAP_EXTRACTION',
    'SEO_CONTENT_BLUEPRINT',
    'STRUCTURED_CONTENT_GENERATION',
    'CONTENT_VALIDATION',
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
    throw new Error(
      'LLM_POLICY_VIOLATION: FRESH_WEB_EVIDENCE must explicitly request search.',
    );
  }
}
