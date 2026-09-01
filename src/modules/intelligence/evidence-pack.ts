/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Evidence Pack
 *
 * Builds the ONLY thing the LLM planner ever sees.
 *
 * THE PLANNER GETS AN EVIDENCE PACK, NOT DATABASE ACCESS.
 * The planner has no SQL, no client config, no credentials, and no ability to
 * ask for more data. It receives a bounded, sanitized snapshot and returns a
 * choice from a closed vocabulary. That containment is what makes prompt
 * injection a non-event: text scraped from a competitor's page arrives here as
 * a quoted string value, and the worst it can do is ask for an action the
 * validator rejects.
 *
 * TWO RULES ENFORCED HERE:
 *
 * 1. NO SECRETS. `clients.posthogApiKey` and `clients.config` never enter a
 *    pack. Redaction is by allow-list, not by blocklist: only named fields are
 *    copied out, so a credential added to a table tomorrow cannot leak through
 *    a pattern nobody updated.
 *
 * 2. UNTRUSTED TEXT IS MARKED AND BOUNDED. Free text that originated outside
 *    the system (competitor titles, snippets, page paths) is truncated and
 *    carried under an `untrusted` key, so the prompt can tell the model
 *    explicitly which fields are data rather than instructions.
 */

import type { ScoredOpportunity } from "./opportunity-scorer.js";
import type { ExtractedSignal } from "./signal-extractor.js";

/** Hard cap on any single free-text field entering a prompt. */
export const MAX_TEXT_LENGTH = 300;

/** Hard cap on signals per opportunity, so pack size stays bounded. */
export const MAX_SIGNALS_PER_OPPORTUNITY = 10;

/**
 * Replace C0/C7F control characters with spaces.
 *
 * Written as an explicit code-point scan rather than a regex character class:
 * the class would put raw control bytes in this source file and trips
 * `noControlCharactersInRegex`, and suppressing a lint rule to express
 * "match control characters" reads worse than just saying which code points
 * are meant. Iterating the string by code point (not by UTF-16 unit) keeps
 * astral characters -- emoji in a competitor's page title -- intact.
 */
function stripControlChars(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out;
}

/**
 * Evidence keys that may be copied out of a signal, per signal type.
 *
 * Allow-list, deliberately. A blocklist ("strip anything called *_key") fails
 * the moment someone adds `posthog_token`; an allow-list fails safe, by
 * omitting the new field until a human adds it here.
 */
const EVIDENCE_ALLOW_LIST: Record<string, readonly string[]> = {
  keyword_drop: ["keyword", "currentPosition", "previousPosition", "delta"],
  bad_lcp_high_exit: ["path", "lcp", "exitRate", "avgTimeOnPage", "uniqueVisitors", "device"],
  citation_loss: ["platform", "query", "competitorCited"],
  prospect_ready: ["targetUrl", "domainRating", "relevanceScore", "tactic"],
};

/** Fields whose content originated outside the system and must be marked. */
const UNTRUSTED_FIELDS = new Set([
  "keyword",
  "path",
  "query",
  "competitorCited",
  "targetUrl",
  "title",
  "snippet",
]);

export interface EvidencePackSignal {
  signalType: string;
  severity: string;
  strength: number;
  /** Allow-listed, sanitized evidence fields. */
  facts: Record<string, unknown>;
  /** Subset of `facts` that came from outside the system. */
  untrusted: Record<string, string>;
}

export interface EvidencePackOpportunity {
  opportunityType: string;
  score: number;
  impact: number;
  confidence: number;
  risk: number;
  signals: EvidencePackSignal[];
}

export interface EvidencePack {
  clientId: string;
  /** Domain only - never the client's config blob or API keys. */
  clientDomain: string;
  industry: string;
  mode: string;
  /** The closed set the planner must choose from. */
  allowedActions: readonly string[];
  opportunities: EvidencePackOpportunity[];
}

/**
 * Strip control characters, collapse whitespace, and cap length.
 *
 * Control characters go first because they can smuggle formatting that breaks
 * out of the JSON block this text is rendered into.
 */
export function sanitizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  const cleaned = stripControlChars(str).replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_TEXT_LENGTH ? `${cleaned.slice(0, MAX_TEXT_LENGTH)}...` : cleaned;
}

/** Copy only allow-listed fields out of a signal's evidence. */
export function sanitizeEvidence(
  signalType: string,
  evidence: Record<string, unknown>,
): { facts: Record<string, unknown>; untrusted: Record<string, string> } {
  const allowed = EVIDENCE_ALLOW_LIST[signalType] ?? [];
  const facts: Record<string, unknown> = {};
  const untrusted: Record<string, string> = {};

  for (const key of allowed) {
    if (!Object.hasOwn(evidence, key)) continue;
    const raw = evidence[key];
    if (raw === null || raw === undefined) continue;

    if (UNTRUSTED_FIELDS.has(key)) {
      const text = sanitizeText(raw);
      if (text === "") continue;
      facts[key] = text;
      untrusted[key] = text;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      facts[key] = raw;
    } else {
      facts[key] = sanitizeText(raw);
    }
  }

  return { facts, untrusted };
}

export interface BuildPackInput {
  clientId: string;
  clientDomain: string;
  industry: string;
  mode: string;
  allowedActions: readonly string[];
  opportunities: ScoredOpportunity[];
  /** Signals keyed by fingerprint, for resolving each opportunity's cluster. */
  signalsByFingerprint: Map<string, ExtractedSignal>;
}

/**
 * Build the pack.
 *
 * Cross-tenant contamination is checked here as well as in the extractor: this
 * is the last point before data leaves the system boundary and reaches a
 * third-party model, so it is worth paying for the check twice.
 */
export function buildEvidencePack(input: BuildPackInput): EvidencePack {
  const opportunities: EvidencePackOpportunity[] = [];

  for (const opportunity of input.opportunities) {
    if (opportunity.clientId !== input.clientId) {
      throw new Error(
        "intelligence: refusing to build an evidence pack containing another client's opportunity",
      );
    }

    const signals: EvidencePackSignal[] = [];
    for (const fingerprint of opportunity.signalFingerprints.slice(
      0,
      MAX_SIGNALS_PER_OPPORTUNITY,
    )) {
      const signal = input.signalsByFingerprint.get(fingerprint);
      if (!signal) continue;
      if (signal.clientId !== input.clientId) {
        throw new Error(
          "intelligence: refusing to build an evidence pack containing another client's signal",
        );
      }
      const { facts, untrusted } = sanitizeEvidence(signal.signalType, signal.evidence);
      signals.push({
        signalType: signal.signalType,
        severity: signal.severity,
        strength: signal.strength,
        facts,
        untrusted,
      });
    }

    opportunities.push({
      opportunityType: opportunity.opportunityType,
      score: opportunity.score,
      impact: opportunity.impact,
      confidence: opportunity.confidence,
      risk: opportunity.risk,
      signals,
    });
  }

  return {
    clientId: input.clientId,
    clientDomain: sanitizeText(input.clientDomain),
    industry: sanitizeText(input.industry),
    mode: input.mode,
    allowedActions: input.allowedActions,
    opportunities,
  };
}

/**
 * Assert a built pack carries no credential-shaped content.
 *
 * The allow-list already guarantees this structurally. This is a cheap
 * belt-and-braces check that runs before the pack is serialized into a prompt,
 * so a future edit that widens the allow-list trips a test instead of leaking.
 */
export function assertNoSecrets(pack: EvidencePack): void {
  const serialized = JSON.stringify(pack).toLowerCase();
  const forbidden = [
    "posthogapikey",
    "posthog_api_key",
    "apikey",
    "api_key",
    "password",
    "github_token",
    "authorization",
    "bearer ",
  ];
  const hit = forbidden.find((needle) => serialized.includes(needle));
  if (hit) {
    throw new Error(`intelligence: evidence pack contains a forbidden key pattern (${hit})`);
  }
}
