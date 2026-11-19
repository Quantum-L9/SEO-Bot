import { TaskComplexity, type TaskDescriptor, TaskType } from "@quantum-l9/llm-router";
import {
  LlmOutputBudgetExceededError,
  SEO_IMPROVE_OUTPUT_TOKEN_CEILING,
} from "./seo-blueprint-output-budget.js";

export {
  LlmOutputBudgetExceededError,
  SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS,
  SEO_BLUEPRINT_INTENT_ROUTE_OUTPUT_TOKENS,
  SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS,
  SEO_IMPROVE_OUTPUT_TOKEN_CEILING,
  seoBlueprintBatchOutputTokens,
  seoBlueprintGlobalIntentOutputTokens,
} from "./seo-blueprint-output-budget.js";

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
  // The default for an UNSIZED call only. Both blueprint call shapes size their
  // own budget from their route count — see `seoBlueprintGlobalIntentOutputTokens`
  // and `seoBlueprintBatchOutputTokens` below.
  SEO_CONTENT_BLUEPRINT: {
    type: TaskType.STRATEGIC_REASONING,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 5000,
    requiresReasoning: true,
    requiresSearch: false,
  },
  // One route of final prose per call. Sized in STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS.
  STRUCTURED_CONTENT_GENERATION: {
    type: TaskType.CONTENT_GENERATION,
    complexity: TaskComplexity.HIGH,
    expectedOutputTokens: 12_000,
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

/**
 * Output budget for ONE structured-content route (final prose).
 *
 * A route is written as final prose for every requirement one blueprint route
 * declares, across up to eleven content slots, so it is longer than the
 * requirement list that commissions it: 3 × SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS
 * (10,500) for the sections, plus 1,500 for metadata, FAQs, internal links and
 * schema inputs = 12,000. The old 7,000 was two blueprint routes' worth.
 */
export const STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS = 12_000;

function withinCeiling(operation: SeoImproveLlmOperation, tokens: number, detail: string): number {
  if (tokens > SEO_IMPROVE_OUTPUT_TOKEN_CEILING) {
    throw new LlmOutputBudgetExceededError(
      operation,
      tokens,
      SEO_IMPROVE_OUTPUT_TOKEN_CEILING,
      detail,
    );
  }
  return tokens;
}

/**
 * Build the governed task descriptor. `expectedOutputTokens` overrides the
 * policy default for a call that sizes its own budget; it must be a positive
 * integer no larger than {@link SEO_IMPROVE_OUTPUT_TOKEN_CEILING}.
 */
export function seoImproveTask(
  operation: SeoImproveLlmOperation,
  clientId: string,
  description: string,
  overrides: { expectedOutputTokens?: number } = {},
): TaskDescriptor {
  const entry = SEO_IMPROVE_LLM_POLICY[operation];
  const expectedOutputTokens = overrides.expectedOutputTokens ?? entry.expectedOutputTokens;
  if (expectedOutputTokens !== undefined) {
    if (!Number.isInteger(expectedOutputTokens) || expectedOutputTokens < 1) {
      throw new RangeError(
        `expectedOutputTokens must be a positive integer, got ${expectedOutputTokens}`,
      );
    }
    withinCeiling(operation, expectedOutputTokens, "call");
  }
  return {
    ...entry,
    expectedOutputTokens,
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
