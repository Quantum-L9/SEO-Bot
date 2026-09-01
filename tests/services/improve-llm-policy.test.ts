import { TaskType } from "@quantum-l9/llm-router";
import { describe, expect, it } from "vitest";
import {
  assertSeoImprovePolicy,
  SEO_IMPROVE_LLM_POLICY,
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
