import { describe, expect, it } from "vitest";
import {
  isTruncatedFinish,
  LlmOutputTruncatedError,
  parseJsonFromLlm,
  parseScore,
} from "../../src/services/llm-parse.js";

describe("parseJsonFromLlm", () => {
  it("parses plain JSON", () => {
    expect(parseJsonFromLlm<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json fences", () => {
    expect(parseJsonFromLlm('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonFromLlm("```\n[1,2,3]\n```")).toEqual([1, 2, 3]);
  });

  it("recovers JSON embedded in a prose preamble/suffix", () => {
    expect(parseJsonFromLlm('Sure! Here you go: {"ok":true} — hope that helps')).toEqual({
      ok: true,
    });
  });

  it("extracts the FIRST balanced JSON value when multiple blocks are present", () => {
    // A greedy first-open-to-last-close match would capture `{"a":1} ... {"b":2}`
    // and fail to parse; the balanced scan returns just the first value.
    expect(parseJsonFromLlm('{"a":1} and then {"b":2}')).toEqual({ a: 1 });
    expect(parseJsonFromLlm("[1,2] then [3,4]")).toEqual([1, 2]);
  });

  it("is not fooled by brackets inside string values", () => {
    expect(parseJsonFromLlm('{"note":"a } b ] c"} trailing')).toEqual({ note: "a } b ] c" });
  });

  it("throws a clear error (never a raw SyntaxError) on non-JSON", () => {
    expect(() => parseJsonFromLlm("I could not complete that request.")).toThrow(
      /did not return valid JSON/,
    );
  });

  it("does not echo raw model output in the error message", () => {
    const secret = "client PII: john@example.com ssn 123-45-6789";
    try {
      parseJsonFromLlm(secret);
      throw new Error("expected parseJsonFromLlm to throw");
    } catch (e: any) {
      expect(e.message).not.toContain("john@example.com");
      expect(e.message).not.toContain("123-45-6789");
    }
  });
});

describe("parseScore", () => {
  it("parses a numeric reply", () => {
    expect(parseScore("87")).toBe(87);
    expect(parseScore("  42.5  ")).toBe(42.5);
  });

  it("clamps to 0–100", () => {
    expect(parseScore("150")).toBe(100);
    expect(parseScore("-10")).toBe(0);
  });

  it("throws on a non-numeric reply instead of returning NaN", () => {
    expect(() => parseScore("high")).toThrow(/numeric score/);
    expect(() => parseScore("")).toThrow(/numeric score/);
  });
});

describe("isTruncatedFinish", () => {
  it("treats the OpenAI/OpenRouter `length` and native cap spellings as truncation", () => {
    for (const reason of ["length", "LENGTH", "max_tokens", "MAX_TOKENS", "max_output_tokens"]) {
      expect(isTruncatedFinish(reason, 10, 5000)).toBe(true);
    }
  });

  it("an explicit non-cap finish reason is authoritative, even at the cap", () => {
    expect(isTruncatedFinish("stop", 5000, 5000)).toBe(false);
    expect(isTruncatedFinish("end_turn", 5000, 5000)).toBe(false);
  });

  it("with no finish reason, output tokens at or over the cap mean truncation", () => {
    expect(isTruncatedFinish(undefined, 5000, 5000)).toBe(true);
    expect(isTruncatedFinish(null, 5001, 5000)).toBe(true);
    expect(isTruncatedFinish("", 4999, 5000)).toBe(false);
  });

  it("an unknown cap (0) never infers truncation from token counts", () => {
    expect(isTruncatedFinish(undefined, 0, 0)).toBe(false);
  });
});

describe("LlmOutputTruncatedError", () => {
  it("carries measurements only and bounds the provider's finish reason", () => {
    const error = new LlmOutputTruncatedError({
      operation: "SEO_CONTENT_BLUEPRINT",
      purpose: "[build-intelligence] seo-content-blueprint:batch-2:b1",
      attempt: "initial",
      maxOutputTokens: 14_500,
      outputTokens: 14_500,
      finishReason: `length${"x".repeat(200)}`,
      responseLength: 65_000,
    });
    expect(error.name).toBe("LlmOutputTruncatedError");
    expect(error.code).toBe("LLM_OUTPUT_TRUNCATED");
    expect(error.finishReason?.length).toBe(32);
    expect(error.message).toContain("batch-2");
    expect(error.message).toContain("14500-token output cap");
    expect(error.message).toContain("response length=65000");
  });
});
