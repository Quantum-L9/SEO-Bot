/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - LLM output parsing helpers
 *
 * Pure, dependency-free parsers for model output. Kept separate from llm.ts so
 * they can be unit-tested without the @quantum-l9/llm-router runtime. Model
 * output is untrusted: the "respond with JSON only / a number only" system
 * prompts are guidance, not guarantees, so every parse is defensive.
 *
 * Error messages never echo the raw model output — callers log error.message
 * and the scheduler persists it to job_executions.error, so echoing could leak
 * client content/PII into logs and the DB.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Return the first balanced JSON value ({…} or […]) in `text`, or null.
 * Scans from the first opening bracket, tracking string/escape state so braces
 * inside string literals don't miscount. This finds the FIRST complete value
 * even when the reply contains multiple JSON blocks or trailing prose (a greedy
 * "first-open to last-close" match would over-capture and fail to parse).
 */
/**
 * Tracks whether the scan cursor is inside a JSON string literal, so braces and
 * brackets inside strings don't miscount. `consume` returns true when the
 * character belongs to a string literal (or opens one) and the caller should
 * skip structural bracket handling for it.
 */
class JsonStringScanner {
  private inString = false;
  private escaped = false;

  consume(ch: string): boolean {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (ch === "\\") this.escaped = true;
      else if (ch === '"') this.inString = false;
      return true;
    }
    if (ch === '"') {
      this.inString = true;
      return true;
    }
    return false;
  }
}

function firstJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  const scanner = new JsonStringScanner();

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (scanner.consume(ch)) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse JSON from an LLM response. Tolerates ```json fences and a prose
 * preamble/suffix by falling back to the first balanced {…} / […] span.
 * Throws a clear, catchable, non-echoing error when no usable JSON is present.
 */
export function parseJsonFromLlm<T>(raw: string): T {
  const text = String(raw ?? "").trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // fall through to span extraction
  }

  const span = firstJsonSpan(unfenced);
  if (span) {
    try {
      return JSON.parse(span) as T;
    } catch {
      // fall through to error
    }
  }
  throw new Error(`LLM did not return valid JSON (response length=${text.length})`);
}

/**
 * Parse a numeric score from an LLM response. Requires a finite number (a
 * non-numeric reply would otherwise silently become NaN and poison downstream
 * comparisons); clamps to the documented 0–100 range. Non-echoing error.
 */
export function parseScore(raw: string): number {
  const text = String(raw ?? "").trim();
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) {
    throw new TypeError(`LLM did not return a numeric score (response length=${text.length})`);
  }
  return Math.min(100, Math.max(0, n));
}

/**
 * Provider finish reasons that mean "stopped at the output-token cap".
 * OpenRouter and Perplexity normalize to the OpenAI `length`; the native
 * spellings (Anthropic `max_tokens`, Gemini `MAX_TOKENS`, OpenAI Responses
 * `max_output_tokens`) are accepted too, so a gateway that passes the native
 * reason through is still recognised. Compared case-insensitively.
 */
const TRUNCATION_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

/**
 * True when a reply was cut at its output cap.
 *
 * The provider's finish reason is authoritative when present. When it is
 * absent (some upstreams omit it), a reply whose measured output tokens reached
 * the cap is treated as truncated — it cannot be distinguished from one, and a
 * truncated reply must never be parsed as success.
 */
export function isTruncatedFinish(
  finishReason: string | null | undefined,
  outputTokens: number,
  maxOutputTokens: number,
): boolean {
  if (typeof finishReason === "string" && finishReason.trim() !== "") {
    return TRUNCATION_FINISH_REASONS.has(finishReason.trim().toLowerCase());
  }
  return maxOutputTokens > 0 && outputTokens >= maxOutputTokens;
}

/** Which call of a governed operation hit the cap. */
export type TruncatedAttempt = "initial" | "repair";

/**
 * A governed LLM reply stopped at its output-token cap. Distinct from a parse
 * or schema failure: the reply is incomplete, so it is never parsed, and a
 * repair under a comparable cap would be cut the same way, so it is never
 * repaired either — the operation fails closed on the first truncation.
 *
 * Carries measurements only; never any model output.
 */
export class LlmOutputTruncatedError extends Error {
  readonly code = "LLM_OUTPUT_TRUNCATED";
  readonly operation: string;
  readonly purpose: string;
  readonly attempt: TruncatedAttempt;
  readonly maxOutputTokens: number;
  readonly outputTokens: number;
  readonly finishReason: string | null;
  readonly responseLength: number;

  constructor(details: {
    operation: string;
    purpose: string;
    attempt: TruncatedAttempt;
    maxOutputTokens: number;
    outputTokens: number;
    finishReason: string | null | undefined;
    responseLength: number;
  }) {
    // The provider's finish reason is a short enum, but it is still provider
    // input: bound it so a misbehaving upstream cannot inflate the message.
    const finishReason =
      typeof details.finishReason === "string" && details.finishReason.trim() !== ""
        ? details.finishReason.trim().slice(0, 32)
        : null;
    super(
      `LLM_OUTPUT_TRUNCATED: ${details.operation} ${details.purpose} (${details.attempt} call) ` +
        `stopped at its ${details.maxOutputTokens}-token output cap ` +
        `(finish_reason=${finishReason ?? "absent"}, output_tokens=${details.outputTokens}, ` +
        `response length=${details.responseLength}); a truncated reply is never parsed or repaired`,
    );
    this.name = "LlmOutputTruncatedError";
    this.operation = details.operation;
    this.purpose = details.purpose;
    this.attempt = details.attempt;
    this.maxOutputTokens = details.maxOutputTokens;
    this.outputTokens = details.outputTokens;
    this.finishReason = finishReason;
    this.responseLength = details.responseLength;
  }
}
