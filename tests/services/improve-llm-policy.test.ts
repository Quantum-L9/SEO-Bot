import { TaskType } from "@quantum-l9/llm-router";
import { describe, expect, it } from "vitest";
import {
  assertSeoImprovePolicy,
  LlmOutputBudgetExceededError,
  SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS,
  SEO_IMPROVE_LLM_POLICY,
  SEO_IMPROVE_OUTPUT_TOKEN_CEILING,
  STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS,
  seoBlueprintBatchOutputTokens,
  seoBlueprintGlobalIntentOutputTokens,
  seoImproveTask,
} from "../../src/services/improve-llm-policy.js";

describe("SEO-Bot improve LLM policy", () => {
  it("declares capability only — no provider or model fields", () => {
    for (const entry of Object.values(SEO_IMPROVE_LLM_POLICY)) {
      const keys = Object.keys(entry);
      expect(keys).not.toContain("provider");
      expect(keys).not.toContain("model");
      expect(keys).not.toContain("clientId");
      expect(keys).not.toContain("description");
    }
  });

  it("keeps CompetitiveLandscape out of the LLM policy (deterministic SERP work)", () => {
    expect(Object.keys(SEO_IMPROVE_LLM_POLICY)).not.toContain("COMPETITIVE_LANDSCAPE");
  });

  it("reasoning/generation/validation operations must not request search", () => {
    for (const op of [
      "SEO_GAP_EXTRACTION",
      "SEO_CONTENT_BLUEPRINT",
      "STRUCTURED_CONTENT_GENERATION",
      "CONTENT_VALIDATION",
      "INTELLIGENCE_ACTION_SELECTION",
    ] as const) {
      expect(SEO_IMPROVE_LLM_POLICY[op].requiresSearch).toBe(false);
    }
  });

  it("only FRESH_WEB_EVIDENCE requests a search provider", () => {
    expect(SEO_IMPROVE_LLM_POLICY.FRESH_WEB_EVIDENCE.requiresSearch).toBe(true);
    expect(SEO_IMPROVE_LLM_POLICY.FRESH_WEB_EVIDENCE.type).toBe(TaskType.MARKET_RESEARCH);
  });

  it("seoImproveTask merges the policy entry with clientId and description", () => {
    const task = seoImproveTask("SEO_CONTENT_BLUEPRINT", "client-1", "blueprint for /home");
    expect(task.clientId).toBe("client-1");
    expect(task.description).toBe("blueprint for /home");
    expect(task.type).toBe(TaskType.STRATEGIC_REASONING);
    expect(task.requiresSearch).toBe(false);
  });

  it("keeps the intelligence action selection on normalized evidence, not search", () => {
    // The evidence pack IS the evidence. A search provider here would let the
    // model reason from the open web about a client it is deliberately not told
    // the identity of — a worse decision and a redaction leak at once.
    expect(SEO_IMPROVE_LLM_POLICY.INTELLIGENCE_ACTION_SELECTION.requiresSearch).toBe(false);
    expect(SEO_IMPROVE_LLM_POLICY.INTELLIGENCE_ACTION_SELECTION.type).toBe(TaskType.SCORING);
  });

  it("assertSeoImprovePolicy passes for the shipped policy", () => {
    expect(() => assertSeoImprovePolicy()).not.toThrow();
  });
});

/**
 * Output budgets are derived, not flat. Evidence: Website-Bot build
 * qap-e2e-001 — 4-route blueprint batches under a flat 5,000-token cap failed
 * with unparseable replies of 22,730 / 22,988 / 52,663 chars (~4.5 chars/token
 * at the cap for the first two).
 */
describe("SEO-improve output budgets", () => {
  // The largest reply observed in qap-e2e-001, in tokens at ~4.5 chars/token.
  const LARGEST_OBSERVED_BLUEPRINT_REPLY_TOKENS = Math.ceil(52_663 / 4.5);

  it("a full blueprint batch is budgeted per route, above every observed reply, under the ceiling", () => {
    // SEO_BLUEPRINT_BATCH_SIZE is 4; the producer test pins that the batch
    // call actually receives this budget.
    const budget = seoBlueprintBatchOutputTokens(4);
    expect(budget).toBe(500 + SEO_BLUEPRINT_ROUTE_OUTPUT_TOKENS * 4);
    expect(budget).toBe(14_500);
    // The old flat cap that truncated: the derived budget must clear it by far.
    expect(budget).toBeGreaterThan(2 * 5000);
    // ≥20% margin over the largest reply observed.
    expect(budget).toBeGreaterThanOrEqual(LARGEST_OBSERVED_BLUEPRINT_REPLY_TOKENS * 1.2);
    expect(budget).toBeLessThanOrEqual(SEO_IMPROVE_OUTPUT_TOKEN_CEILING);
  });

  it("a short final batch gets a proportionally smaller budget", () => {
    expect(seoBlueprintBatchOutputTokens(1)).toBe(4000);
    expect(seoBlueprintBatchOutputTokens(3)).toBe(11_000);
  });

  it("a batch that cannot fit under the ceiling is refused, typed, before any call", () => {
    expect(() => seoBlueprintBatchOutputTokens(5)).toThrow(LlmOutputBudgetExceededError);
    expect(() => seoBlueprintBatchOutputTokens(5)).toThrow("LLM_OUTPUT_BUDGET_EXCEEDED");
    expect(() => seoBlueprintBatchOutputTokens(0)).toThrow(RangeError);
  });

  it("the global intent call keeps the policy floor and grows with the route count", () => {
    expect(seoBlueprintGlobalIntentOutputTokens(4)).toBe(5000);
    expect(seoBlueprintGlobalIntentOutputTokens(29)).toBe(5000);
    expect(seoBlueprintGlobalIntentOutputTokens(60)).toBe(9500);
    expect(() => seoBlueprintGlobalIntentOutputTokens(200)).toThrow(LlmOutputBudgetExceededError);
  });

  it("structured content gets one route's final prose budget, under the ceiling", () => {
    expect(SEO_IMPROVE_LLM_POLICY.STRUCTURED_CONTENT_GENERATION.expectedOutputTokens).toBe(
      STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS,
    );
    expect(STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS).toBe(12_000);
    expect(STRUCTURED_CONTENT_ROUTE_OUTPUT_TOKENS).toBeLessThanOrEqual(
      SEO_IMPROVE_OUTPUT_TOKEN_CEILING,
    );
  });

  it("every policy default fits under the ceiling", () => {
    for (const entry of Object.values(SEO_IMPROVE_LLM_POLICY)) {
      expect(entry.expectedOutputTokens).toBeLessThanOrEqual(SEO_IMPROVE_OUTPUT_TOKEN_CEILING);
    }
  });

  it("seoImproveTask applies a sized override and refuses an invalid one", () => {
    expect(
      seoImproveTask("SEO_CONTENT_BLUEPRINT", "c", "d", { expectedOutputTokens: 14_500 })
        .expectedOutputTokens,
    ).toBe(14_500);
    expect(seoImproveTask("SEO_CONTENT_BLUEPRINT", "c", "d").expectedOutputTokens).toBe(5000);
    expect(() =>
      seoImproveTask("SEO_CONTENT_BLUEPRINT", "c", "d", { expectedOutputTokens: 16_001 }),
    ).toThrow(LlmOutputBudgetExceededError);
    expect(() =>
      seoImproveTask("SEO_CONTENT_BLUEPRINT", "c", "d", { expectedOutputTokens: 0 }),
    ).toThrow(RangeError);
  });
});
