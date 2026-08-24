/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deterministic content grounding (ZERO LLM, ZERO tokens).
 *
 * Semantic validation is secondary authority — it can never rescue content that
 * fails here. These checks answer questions that do not need a model:
 *
 *   - Does the prose assert a factual claim (a duration, a count, a price, a
 *     credential, a warranty, an availability promise) that the contract's
 *     VerifiedBusinessFacts do not support?
 *   - Does it repeat a claim the contract explicitly forbids?
 *   - Does it still contain placeholder or empty filler content?
 *   - Are the contract's required topics and entities actually represented?
 *
 * The canonical regression this exists to stop: prose claiming "decades of
 * experience" when the verified fact says a different, smaller number of years.
 * The number in the prose must be a number the facts actually contain.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type {
  PageContentContractRoute,
  StructuredContentRoute,
  VerifiedBusinessFact,
} from "@quantum-l9/bot-interop";

/** Flatten every piece of author-visible prose in a generated route. */
export function collectRouteText(route: StructuredContentRoute): string {
  const parts: string[] = [route.metadata.title, route.metadata.description];
  for (const section of route.sections) {
    if (section.eyebrow) parts.push(section.eyebrow);
    if (section.heading) parts.push(section.heading);
    if (section.subheading) parts.push(section.subheading);
    if (section.cta) parts.push(section.cta.label, section.cta.action);
    for (const block of section.blocks) {
      if (block.kind === "paragraph") parts.push(block.text);
      else if (block.kind === "quote") {
        parts.push(block.text);
        if (block.attribution) parts.push(block.attribution);
      } else parts.push(...block.items);
    }
  }
  for (const faq of route.faqs) parts.push(faq.question, faq.answer);
  for (const link of route.internal_links) parts.push(link.anchor_text);
  return parts.join("\n");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

/** Everything the contract's verified facts actually assert, as one corpus. */
export function buildFactCorpus(facts: VerifiedBusinessFact[]): string {
  const parts: string[] = [];
  for (const fact of facts) {
    parts.push(fact.key);
    if (Array.isArray(fact.value)) parts.push(...fact.value.map(String));
    else parts.push(String(fact.value));
  }
  return normalize(parts.join(" | "));
}

/** Every distinct number appearing anywhere in the verified facts. */
export function factNumbers(facts: VerifiedBusinessFact[]): Set<string> {
  const numbers = new Set<string>();
  for (const match of buildFactCorpus(facts).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    numbers.add(match[0].replace(/,/g, ""));
  }
  return numbers;
}

/**
 * Quantified claim patterns. Each match yields a number that MUST appear in the
 * verified facts — the category is what makes the number a factual assertion
 * rather than incidental prose.
 */
const QUANTIFIED_CLAIM_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: "years of experience", pattern: /\b(\d{1,4})\s*\+?\s*(?:years?|yrs?)\b/g },
  {
    category: "founding year",
    pattern: /\b(?:since|established(?: in)?|founded(?: in)?)\s+(\d{4})\b/g,
  },
  {
    category: "completed work volume",
    pattern:
      /\b(\d{1,3}(?:,\d{3})*|\d+)\s*\+?\s*(?:projects?|jobs?|installs?|installations?|roofs?|homes?|properties|customers?|clients?|families)\b/g,
  },
  {
    category: "team size",
    pattern: /\b(\d{1,4})\s*\+?\s*(?:employees?|crews?|technicians?|installers?|staff)\b/g,
  },
  {
    category: "response time",
    pattern:
      /\b(\d{1,3})[- ]?(?:minute|hour|day)s?\b(?=[^.]{0,40}\b(?:response|arrival|callback|call back|on[- ]site|service)\b)/g,
  },
  { category: "warranty term", pattern: /\b(\d{1,3})[- ]?year\b(?=[^.]{0,30}\bwarrant)/g },
  { category: "price", pattern: /\$\s?(\d[\d,]*(?:\.\d{2})?)/g },
  { category: "rating", pattern: /\b(\d(?:\.\d)?)\s*(?:-|\s)?star\b/g },
];

/**
 * Magnitude phrases that assert scale without a number. They can never be
 * corroborated by a number, so the phrase itself must appear in the facts.
 */
const MAGNITUDE_PHRASES: readonly string[] = [
  "decades of experience",
  "decades of",
  "generations of",
  "hundreds of",
  "thousands of",
  "countless",
  "years of experience",
];

/**
 * Credential, warranty, and availability claims. Each must be corroborated by
 * the verified facts containing the same token — these are precisely the
 * categories a model will otherwise invent.
 */
export const CREDENTIAL_CLAIM_TOKENS: readonly string[] = [
  "licensed",
  "bonded",
  "insured",
  "certified",
  "certification",
  "accredited",
  "award-winning",
  "award winning",
  "warranty",
  "warranties",
  "guarantee",
  "guaranteed",
  "money-back",
  "24/7",
  "same-day",
  "same day",
  "emergency service",
  "free estimate",
  "free inspection",
  "no obligation",
  "financing available",
];

/** Content that was never actually written. */
const PLACEHOLDER_MARKERS: readonly string[] = [
  "lorem ipsum",
  "todo",
  "tbd",
  "{{",
  "[insert",
  "<insert",
  "placeholder",
  "your company name",
  "coming soon",
  "xxxx",
];

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "our",
  "are",
  "was",
  "you",
  "all",
  "any",
  "can",
  "has",
  "have",
  "into",
  "when",
  "what",
  "how",
  "why",
]);

/**
 * Reduce a token to a coarse stem so required-coverage checks tolerate ordinary
 * inflection ("roofing" satisfies "roof") without accepting a different word.
 */
function stem(token: string): string {
  for (const suffix of ["ing", "ers", "er", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function significantTokens(phrase: string): string[] {
  return normalize(phrase)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3 && !STOPWORDS.has(token))
    .map(stem);
}

/**
 * Deterministic grounding verdict for one generated route. An empty
 * `unsupportedClaims` AND empty `failures` means the route is grounded.
 */
export interface GroundingVerdict {
  unsupportedClaims: string[];
  failures: string[];
}

export function checkRouteGrounding(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): GroundingVerdict {
  const text = collectRouteText(route);
  const haystack = normalize(text);
  const corpus = buildFactCorpus(contractRoute.business_facts);
  const numbers = factNumbers(contractRoute.business_facts);

  const unsupportedClaims: string[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  const flag = (claim: string): void => {
    if (seen.has(claim)) return;
    seen.add(claim);
    unsupportedClaims.push(claim);
  };

  // 1. Quantified factual claims — the asserted number must be a verified number.
  for (const { category, pattern } of QUANTIFIED_CLAIM_PATTERNS) {
    for (const match of haystack.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = (match[1] ?? "").replace(/,/g, "");
      if (!value || numbers.has(value)) continue;
      flag(
        `${route.route_id}: unsupported ${category} claim "${match[0].trim()}" — no verified fact asserts ${value}`,
      );
    }
  }

  // 2. Unquantified magnitude claims — the phrase itself must be verified.
  for (const phrase of MAGNITUDE_PHRASES) {
    if (haystack.includes(phrase) && !corpus.includes(phrase)) {
      flag(
        `${route.route_id}: unsupported magnitude claim "${phrase}" — no verified fact asserts it`,
      );
    }
  }

  // 3. Credential / warranty / availability claims — must be corroborated.
  for (const token of CREDENTIAL_CLAIM_TOKENS) {
    if (haystack.includes(token) && !corpus.includes(token)) {
      flag(
        `${route.route_id}: unsupported credential/guarantee claim "${token}" — no verified fact asserts it`,
      );
    }
  }

  // 4. Explicitly forbidden claims from the contract.
  for (const forbidden of contractRoute.forbidden_claims) {
    const normalized = normalize(forbidden);
    if (normalized && haystack.includes(normalized)) {
      failures.push(`${route.route_id}: contains forbidden claim "${forbidden}"`);
    }
  }

  // 5. Placeholder / unwritten content.
  for (const marker of PLACEHOLDER_MARKERS) {
    if (haystack.includes(marker)) {
      failures.push(`${route.route_id}: contains placeholder content "${marker}"`);
    }
  }

  // 6. Empty or trivially short prose blocks.
  for (const section of route.sections) {
    const words = section.blocks
      .flatMap((block) =>
        block.kind === "paragraph" || block.kind === "quote" ? [block.text] : block.items,
      )
      .join(" ")
      .trim();
    if (words.split(/\s+/).filter(Boolean).length < 10) {
      failures.push(
        `${route.route_id}: section "${section.section_id}" has no substantive content`,
      );
    }
  }

  // 7. Required topics and entities are actually represented.
  failures.push(...checkRequiredCoverage(route.route_id, contractRoute, haystack));

  return { unsupportedClaims, failures };
}

/**
 * Required entities must appear literally; required topics must have every
 * significant token represented somewhere in the route (phrasing is the
 * writer's, coverage is the contract's).
 */
function checkRequiredCoverage(
  routeId: string,
  contractRoute: PageContentContractRoute,
  haystack: string,
): string[] {
  const failures: string[] = [];
  const reportedTopics = new Set<string>();
  const reportedEntities = new Set<string>();

  for (const section of contractRoute.sections) {
    for (const entity of section.content_requirements.entities) {
      const normalized = normalize(entity);
      if (!normalized || reportedEntities.has(normalized)) continue;
      if (!haystack.includes(normalized)) {
        reportedEntities.add(normalized);
        failures.push(`${routeId}: required entity "${entity}" is not represented`);
      }
    }
    for (const topic of section.content_requirements.topics) {
      const normalized = normalize(topic);
      if (!normalized || reportedTopics.has(normalized)) continue;
      const tokens = significantTokens(topic);
      if (tokens.length === 0) continue;
      const missing = tokens.filter((token) => !haystack.includes(token));
      if (missing.length > 0) {
        reportedTopics.add(normalized);
        failures.push(
          `${routeId}: required topic "${topic}" is not covered (missing: ${missing.join(", ")})`,
        );
      }
    }
  }
  return failures;
}
