/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 *
 * Output-token budgets for the build-intelligence blueprint calls. This module
 * does not import @quantum-l9/llm-router; the policy table re-exports it.
 */

const BLUEPRINT_POLICY_OUTPUT_TOKENS = 5_000;

export const SEO_IMPROVE_OUTPUT_TOKEN_CEILING = 16_000;
export const SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS = 3_500;
export const SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS = 500;
export const SEO_BLUEPRINT_INTENT_ROUTE_OUTPUT_TOKENS = 150;

export class LlmOutputBudgetExceededError extends Error {
  readonly code = "LLM_OUTPUT_BUDGET_EXCEEDED";
  constructor(
    readonly operation: string,
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

function withinCeiling(tokens: number, detail: string): number {
  if (tokens > SEO_IMPROVE_OUTPUT_TOKEN_CEILING) {
    throw new LlmOutputBudgetExceededError(
      "SEO_CONTENT_BLUEPRINT",
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
    SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS + SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS * routeCount,
    `batch of ${routeCount} route(s)`,
  );
}

/**
 * Output budget for the Phase A global-intent call over `routeCount` routes.
 * Never below the blueprint policy default, so a small site keeps that budget.
 */
export function seoBlueprintGlobalIntentOutputTokens(routeCount: number): number {
  assertRouteCount(routeCount);
  const derived =
    SEO_BLUEPRINT_BATCH_ENVELOPE_OUTPUT_TOKENS +
    SEO_BLUEPRINT_INTENT_ROUTE_OUTPUT_TOKENS * routeCount;
  return withinCeiling(
    Math.max(BLUEPRINT_POLICY_OUTPUT_TOKENS, derived),
    `global intent plan over ${routeCount} route(s)`,
  );
}
