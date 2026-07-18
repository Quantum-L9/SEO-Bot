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
function firstJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
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
  const text = String(raw ?? '').trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
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
  const text = String(raw ?? '').trim();
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) {
    throw new Error(`LLM did not return a numeric score (response length=${text.length})`);
  }
  return Math.min(100, Math.max(0, n));
}
