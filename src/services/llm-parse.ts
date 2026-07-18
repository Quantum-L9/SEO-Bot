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
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Parse JSON from an LLM response. Tolerates ```json fences and a prose
 * preamble/suffix by falling back to the first balanced-looking {…} / […] span.
 * Throws a clear, catchable error (never an unhandled SyntaxError) when the
 * response contains no usable JSON.
 */
export function parseJsonFromLlm<T>(raw: string): T {
  const text = String(raw ?? '').trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = [unfenced];
  const span = unfenced.match(/[{[][\s\S]*[}\]]/);
  if (span && span[0] !== unfenced) candidates.push(span[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`LLM did not return valid JSON: ${text.slice(0, 200)}`);
}

/**
 * Parse a numeric score from an LLM response. Requires a finite number (a
 * non-numeric reply would otherwise silently become NaN and poison downstream
 * comparisons); clamps to the documented 0–100 range.
 */
export function parseScore(raw: string): number {
  const n = Number.parseFloat(String(raw ?? '').trim());
  if (!Number.isFinite(n)) {
    throw new Error(`LLM did not return a numeric score: ${String(raw).slice(0, 100)}`);
  }
  return Math.min(100, Math.max(0, n));
}
