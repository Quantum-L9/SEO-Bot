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
 * The highest output-token cap any governed SEO-improve call may ask for.
 *
 * The router passes `expectedOutputTokens` through as the provider's
 * `max_tokens`, and a call can fall back across models within its plane:
 * STRATEGIC_REASONING/HIGH and CONTENT_GENERATION/HIGH resolve to
 * `anthropic/claude-sonnet-4` with `openai/gpt-4o` and `google/gemini-2.5-pro`
 * as fallbacks. gpt-4o's completion limit (16,384) is the smallest of the
 * three, so a cap above it would be refused or silently clamped on the
 * fallback. 16,000 stays under it with headroom.
 */
export const SEO_IMPROVE_OUTPUT_TOKEN_CEILING = 16_000;

/**
 * Output budget per route in one SEO_CONTENT_BLUEPRINT batch call.
 *
 * Evidence (Website-Bot build qap-e2e-001, 2026-10-25): three attempts at a
 * 4-route batch under the old flat 5,000-token cap failed with the repair reply
 * unparseable at 22,730, 22,988 and 52,663 chars. 22.7k chars / 5,000 tokens is
 * ~4.5 chars per token, consistent with a cut at the cap (inference: SEO-Bot
 * did not read finish_reason then). 52,663 chars does not fit 5,000 tokens at
 * that density, so that reply was either whitespace-dense or failed otherwise;
 * it is still the largest reply observed (~11,700 tokens at 4.5 chars/token)
 * and the budget is sized to cover it. 3,500 per route gives a 4-route batch
 * 14,500 tokens (~65k chars) — 2.9x the cap that truncated and 24% above that
 * largest reply — and stays under the ceiling.
 */
export const SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS = 3_500;

/** The `{"routes": [...]}` container and separators around a batch's routes. */
export const SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS = 500;

/**
 * Output budget per route in the Phase A global-intent call: four short
 * fields (route_id, primary_query, primary_intent, journey_stage) — well under
 * 100 tokens even pretty-printed, so 150 carries margin.
 */
export const SEO_BLUEPRINT_INTENT_ROUTE_OUTPUT_TOKENS = 150;

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

/** A sized call would need more output than the ceiling allows. Raised before any call. */
export class LlmOutputBudgetExceededError extends Error {
  readonly code = "LLM_OUTPUT_BUDGET_EXCEEDED";
  constructor(
    readonly operation: SeoImproveLlmOperation,
    readonly requestedOutputTokens: number,
    readonly ceilingOutputTokens: number,
    detail: string,
  ) {
    super(
      `LLM_OUTPUT_BUDGET_EXCEEDED: ${operation} ${detail} needs ${requestedOutputTokens} output tokens; ` +
        `the ceiling is ${ceilingOutputTokens}`,
    );
    this.name = "LlmOutputBudgetExceededError";
  }
}

function assertRouteCount(routeCount: number): void {
  if (!Number.isInteger(routeCount) || routeCount < 1) {
    throw new RangeError(`route count must be a positive integer, got ${routeCount}`);
  }
}

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

/** Output budget for one blueprint batch of `routeCount` routes (Phase B). */
export function seoBlueprintBatchOutputTokens(routeCount: number): number {
  assertRouteCount(routeCount);
  return withinCeiling(
    "SEO_CONTENT_BLUEPRINT",
    SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS + SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS * routeCount,
    `batch of ${routeCount} route(s)`,
  );
}

/**
 * Output budget for the Phase A global-intent call over `routeCount` routes.
 * Never below the policy default, so a small site keeps today's budget.
 */
export function seoBlueprintGlobalIntentOutputTokens(routeCount: number): number {
  assertRouteCount(routeCount);
  const derived =
    SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS +
    SEO_BLUEPRINT_INTENT_ROUTE_OUTPUT_TOKENS * routeCount;
  return withinCeiling(
    "SEO_CONTENT_BLUEPRINT",
    Math.max(SEO_IMPROVE_LLM_POLICY.SEO_CONTENT_BLUEPRINT.expectedOutputTokens ?? 0, derived),
    `global intent plan over ${routeCount} route(s)`,
  );
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
