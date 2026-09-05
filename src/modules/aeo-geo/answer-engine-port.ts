/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AnswerEngineObservationPort — the ONE sanctioned boundary where a provider is
 * named directly outside @quantum-l9/llm-router.
 *
 * AEO/GEO measures whether a specific answer engine (e.g. Perplexity) cites the
 * client. Here the engine IS the measurement subject, so calling it directly is
 * legitimate — but it is confined behind this port so no general SEO module ever
 * reaches a provider API directly, and the coupling is explicit and swappable.
 *
 * This port performs OBSERVATION only (does the engine cite us?). It is NOT a
 * generation/reasoning path and must never be used to route content, blueprint,
 * or validation work — those go through the router policy.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from "axios";
import { getConfig } from "../../core/config.js";
import { publishDirectProviderBypass } from "../../services/llm-run-recorder.js";

/** Stable identifier for this bypass site in run evidence. */
const BYPASS_SITE = "aeo-geo:answer-engine-observation";

/** A single answer-engine response observed for a query. */
export interface AnswerEngineObservation {
  /** The engine's natural-language answer (truncated by the caller as needed). */
  content: string;
  /** Source URLs the engine cited, in the engine's order. */
  citations: string[];
}

/** Named engines this port can observe. */
export type AnswerEngineId = "perplexity";

export interface AnswerEngineObservationPort {
  readonly engine: AnswerEngineId;
  observe(query: string, signal?: AbortSignal): Promise<AnswerEngineObservation>;
}

/**
 * Perplexity observation port. Provider identity is intentional: we are asking
 * Perplexity itself what it cites. Request shape is preserved verbatim from the
 * prior inline AEO implementation so citation-check behavior is unchanged.
 */
export class PerplexityAnswerEnginePort implements AnswerEngineObservationPort {
  readonly engine = "perplexity" as const;

  async observe(query: string, signal?: AbortSignal): Promise<AnswerEngineObservation> {
    const config = getConfig();
    // Run evidence counts BYPASSES THAT HAPPENED. This is the single sanctioned
    // site where a provider is reached outside @quantum-l9/llm-router, so every
    // invocation is published before the request leaves — an open run recorder
    // therefore reports a non-zero count exactly when one occurred, and reports
    // zero only because none did.
    publishDirectProviderBypass({
      site: BYPASS_SITE,
      engine: this.engine,
      rationale:
        "AEO/GEO measures whether this answer engine cites the client; the engine is the " +
        "measurement subject, so it is observed directly rather than routed.",
    });
    const response = await axios.post(
      "https://api.perplexity.ai/chat/completions",
      {
        model: "llama-3.1-sonar-small-128k-online",
        messages: [{ role: "user", content: query }],
        return_citations: true,
      },
      {
        headers: { Authorization: `Bearer ${config.PERPLEXITY_API_KEY}` },
        timeout: 30000,
        signal,
      },
    );
    return {
      content: response.data.choices?.[0]?.message?.content || "",
      citations: response.data.citations || [],
    };
  }
}

let _perplexityPort: AnswerEngineObservationPort | null = null;

/** Resolve the observation port for a named answer engine (singleton). */
export function getAnswerEnginePort(engine: AnswerEngineId): AnswerEngineObservationPort {
  if (engine === "perplexity") {
    _perplexityPort ??= new PerplexityAnswerEnginePort();
    return _perplexityPort;
  }
  throw new Error(`Unsupported answer engine: ${engine}`);
}
