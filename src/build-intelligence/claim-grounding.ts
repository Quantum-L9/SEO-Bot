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
 *   - Are section proof_requirements token-covered in that section's prose?
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

function collectSectionProse(section: StructuredContentRoute["sections"][number]): string {
  const parts: string[] = [];
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
  return parts.join("\n");
}

/** Flatten every piece of author-visible prose in a generated route. */
export function collectRouteText(route: StructuredContentRoute): string {
  const parts: string[] = [route.metadata.title, route.metadata.description];
  for (const section of route.sections) {
    parts.push(collectSectionProse(section));
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
    numbers.add(match[0].replaceAll(",", ""));
  }
  return numbers;
}

/**
 * Quantified claim patterns. Each match yields a number that MUST appear in the
 * verified facts — the category is what makes the number a factual assertion
 * rather than incidental prose.
 */
const QUANTIFIED_CLAIM_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: "years of experience", pattern: /\b(\d{1,4})(?:\s*\+)?\s*(?:years?|yrs?)\b/g },
  {
    category: "founding year",
    pattern: /\b(?:since|established(?: in)?|founded(?: in)?)\s+(\d{4})\b/g,
  },
  {
    category: "completed work volume",
    pattern:
      /\b(\d{1,3}(?:,\d{3})*|\d+)(?:\s*\+)?\s*(?:(?:project|job|install(?:ation)?|roof|home|customer|client)s?|properties|families)\b/g,
  },
  {
    category: "team size",
    pattern: /\b(\d{1,4})(?:\s*\+)?\s*(?:(?:employee|crew|technician|installer)s?|staff)\b/g,
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
export const MAGNITUDE_PHRASES: readonly string[] = [
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
  const numbers = factNumbers(contractRoute.business_facts);

  const checklist = routeRequirementChecklist(contractRoute);
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
      const value = (match[1] ?? "").replaceAll(",", "");
      if (!value || numbers.has(value)) continue;
      flag(
        `${route.route_id}: unsupported ${category} claim "${match[0].trim()}" — no verified fact asserts ${value}`,
      );
    }
  }

  // 2. Unquantified magnitude claims — the phrase itself must be verified.
  for (const phrase of checklist.ungrounded_magnitude_phrases) {
    if (haystack.includes(phrase)) {
      flag(
        `${route.route_id}: unsupported magnitude claim "${phrase}" — no verified fact asserts it`,
      );
    }
  }

  // 3. Credential / warranty / availability claims — must be corroborated.
  for (const token of checklist.ungrounded_claim_tokens) {
    if (haystack.includes(token)) {
      flag(
        `${route.route_id}: unsupported credential/guarantee claim "${token}" — no verified fact asserts it`,
      );
    }
  }

  // 4. Explicitly forbidden claims from the contract.
  for (const forbidden of checklist.forbidden_claims) {
    if (haystack.includes(normalize(forbidden))) {
      failures.push(`${route.route_id}: contains forbidden claim "${forbidden}"`);
    }
  }

  // 5. Placeholder / unwritten content.
  for (const marker of checklist.placeholder_markers) {
    if (haystack.includes(marker)) {
      failures.push(`${route.route_id}: contains placeholder content "${marker}"`);
    }
  }

  // 6. Empty or trivially short prose. An FAQ section renders the route-level
  //    faqs (the output contract puts Q&A ONLY there and lets the section carry
  //    `blocks: []`), so its substance counts the faqs it renders. The 10-word
  //    floor itself is unchanged.
  const sectionRules = new Map(checklist.sections.map((entry) => [entry.section_id, entry]));
  const routeFaqProse = route.faqs.flatMap((faq) => [faq.question, faq.answer]);
  for (const section of route.sections) {
    const rules = sectionRules.get(section.section_id);
    const words = [
      ...section.blocks.flatMap((block) =>
        block.kind === "paragraph" || block.kind === "quote" ? [block.text] : block.items,
      ),
      ...(rules?.is_faq ? routeFaqProse : []),
    ]
      .join(" ")
      .trim();
    if (words.split(/\s+/).filter(Boolean).length < (rules?.min_words ?? SUBSTANCE_MIN_WORDS)) {
      failures.push(
        `${route.route_id}: section "${section.section_id}" has no substantive content`,
      );
    }
  }

  // 7. Quote attribution: a quote must name an external source that the
  //    contract's evidence (the verified facts) contains, never the business.
  // 8. Presentation limits: short fields the renderer shows as nav labels,
  //    uppercase eyebrows and buttons. A violation is reported with the exact
  //    field and word count — never truncated.
  // 9. Required topics and entities are actually represented.
  failures.push(
    ...checkQuoteAttributions(route, checklist.quote_attribution),
    ...checkPresentationLimits(route, checklist.presentation_limits),
    ...checkRequiredCoverage(route.route_id, checklist, haystack),
  );

  return { unsupportedClaims, failures };
}

/**
 * A contract section that renders the route-level FAQ: its component is the
 * FAQ component, or it carries the `faq` content slot. Website-Bot renders the
 * route `faqs` accordion inside that section.
 */
export function isFaqContractSection(
  section: PageContentContractRoute["sections"][number],
): boolean {
  return section.component_class.trim().toLowerCase() === "faq" || section.slots.includes("faq");
}

/** Section ids of the route's FAQ sections. */
export function faqSectionIds(contractRoute: PageContentContractRoute): Set<string> {
  return new Set(
    contractRoute.sections.filter(isFaqContractSection).map((section) => section.section_id),
  );
}

/**
 * Required entities, per contract section, exactly as the coverage check
 * matches them: literal, case-insensitive, whitespace-collapsed.
 */
export function requiredEntitiesBySection(
  contractRoute: PageContentContractRoute,
): Array<{ section_id: string; entities: string[] }> {
  return routeRequirementChecklist(contractRoute)
    .sections.map((section) => ({ section_id: section.section_id, entities: section.entities }))
    .filter((entry) => entry.entities.length > 0);
}

/* ── Requirement checklist: the ONE spec the validator and the prompt share ── */

/** Words a section must carry before it counts as substantive content. */
export const SUBSTANCE_MIN_WORDS = 10;

/**
 * Word limits for short fields, mirroring Website-Bot's blocking site-quality
 * checker (src/validation/site-quality/checks.ts), which is the rendering
 * authority. These are mirrored constants until the page-content contract
 * carries them from Website-Bot.
 */
export const PRESENTATION_LIMITS = {
  /** `internal_links[].anchor_text` renders as a nav label: nav-label-run-on, at most 5 words. */
  anchor_text: 5,
  /**
   * `sections[].eyebrow` renders UPPERCASE: isTitleCaseRunOn flags 6+ letter
   * tokens without sentence punctuation when ≥85% are capitalized, and
   * uppercase always counts as capitalized — so at most 5 words.
   */
  eyebrow: 5,
  /** `sections[].cta.label` renders as a non-link control (button): at most 8 words. */
  cta_label: 8,
} as const;

export type PresentationLimits = { readonly [K in keyof typeof PRESENTATION_LIMITS]: number };

/** Whitespace-separated words, as the renderer's checker counts them. */
export function presentationWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function checkPresentationLimits(
  route: StructuredContentRoute,
  limits: PresentationLimits,
): string[] {
  const failures: string[] = [];
  const over = (field: string, text: string | undefined, limit: number): void => {
    if (text === undefined) return;
    const words = presentationWordCount(text);
    if (words > limit) {
      failures.push(`${route.route_id}: ${field} has ${words} words (limit ${limit})`);
    }
  };
  route.internal_links.forEach((link, index) => {
    over(`internal_links[${index}].anchor_text`, link.anchor_text, limits.anchor_text);
  });
  for (const section of route.sections) {
    over(`sections.${section.section_id}.eyebrow`, section.eyebrow, limits.eyebrow);
    over(`sections.${section.section_id}.cta.label`, section.cta?.label, limits.cta_label);
  }
  return failures;
}

/** A topic and the stemmed tokens the coverage check looks for, as substrings. */
export interface TokenRequirement {
  phrase: string;
  tokens: string[];
}

/** Every deterministic requirement one contract section imposes. */
export interface SectionRequirementChecklist {
  section_id: string;
  /** Renders the route-level faqs: its substance counts them. */
  is_faq: boolean;
  min_words: number;
  /** Must appear literally (case-insensitive, whitespace-collapsed). */
  entities: string[];
  /** Every token must appear (as a substring) somewhere in the route. */
  topics: Array<{ topic: string; tokens: string[] }>;
  /** Questions the section must answer (judged semantically). */
  questions: string[];
  /** Every token must appear in THIS section's prose (proof-echo gate). */
  proofs: Array<{ proof: string; tokens: string[] }>;
}

/**
 * Every deterministic check the validator applies to one route, derived from
 * the contract. `checkRouteGrounding`, `unsatisfiedProofRequirements` and the
 * generation/repair prompts all read THIS object, so the prompt can never ask
 * for less than the validator checks.
 */
export interface RouteRequirementChecklist {
  route_id: string;
  section_ids: string[];
  sections: SectionRequirementChecklist[];
  internal_link_targets: string[];
  metadata: { title: string[]; description: string[] };
  forbidden_claims: string[];
  placeholder_markers: readonly string[];
  /** Credential/guarantee tokens no verified fact grounds. */
  ungrounded_claim_tokens: string[];
  /** Magnitude phrases no verified fact grounds. */
  ungrounded_magnitude_phrases: string[];
  /** The only numbers a quantified claim may assert. */
  verified_numbers: string[];
  /** Word limits for short rendered fields (Website-Bot site-quality rules). */
  presentation_limits: PresentationLimits;
  /** Who a quote block may be attributed to (and who it never may be). */
  quote_attribution: QuoteAttributionRules;
}

/**
 * Quote attribution rules. A quote block is evidence of what someone else
 * said, so its attribution must name a source the contract's evidence (the
 * route's verified facts) contains, and never the business itself. QAP
 * canary10 shipped "The operational test is whether a team can follow through
 * …" attributed to "Quantum AI Partners methodology statement".
 */
export interface QuoteAttributionRules {
  /** Normalized text of the route's verified facts: an attribution must appear in it. */
  evidence_corpus: string;
  /** The business's own names, from its verified name facts (normalized). */
  self_names: string[];
  /** Words that make an attribution a self-reference, whoever it names. */
  self_reference_terms: readonly string[];
}

/** Attribution words that describe the business's own voice, not a source. */
export const QUOTE_SELF_REFERENCE_TERMS: readonly string[] = [
  "methodology",
  "statement",
  "philosophy",
  "manifesto",
  "principle",
  "principles",
  "approach",
  "our",
  "we",
  "us",
];

/** Verified facts that name the business itself. */
const BUSINESS_NAME_FACT_KEY =
  /(^|_)(company|business|brand|legal|trading|organization|organisation)?_?name$/;

function quoteAttributionRules(facts: VerifiedBusinessFact[]): QuoteAttributionRules {
  return {
    evidence_corpus: normalize(buildFactCorpus(facts)),
    self_names: facts
      .filter((fact) => BUSINESS_NAME_FACT_KEY.test(fact.key.trim().toLowerCase()))
      .flatMap((fact) => (Array.isArray(fact.value) ? fact.value : [fact.value]))
      .map((value) => normalize(String(value)))
      .filter(Boolean),
    self_reference_terms: QUOTE_SELF_REFERENCE_TERMS,
  };
}

/** Strip a leading dash ("— Jane Doe") and trailing dots or spaces, without regex backtracking. */
function trimAttribution(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && /[-–—\s]/.test(value.charAt(start))) start += 1;
  while (end > start && /[.\s]/.test(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/** Why an attribution is not acceptable, or null when it is. */
export function quoteAttributionProblem(
  attribution: string | undefined,
  rules: QuoteAttributionRules,
): string | null {
  const name = trimAttribution(normalize(attribution ?? ""));
  if (!name) return "no attribution";
  if (rules.self_names.some((self) => name.includes(self))) return "names the business itself";
  const words = new Set(name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const term = rules.self_reference_terms.find((candidate) => words.has(candidate));
  if (term) return `is a self-reference ("${term}")`;
  // The source is the name before any role or affiliation ("Jane Doe, VP at X").
  const source = name.split(",")[0]?.trim() ?? name;
  if (!rules.evidence_corpus.includes(name) && !rules.evidence_corpus.includes(source)) {
    return "is not in the contract's evidence";
  }
  return null;
}

function checkQuoteAttributions(
  route: StructuredContentRoute,
  rules: QuoteAttributionRules,
): string[] {
  const failures: string[] = [];
  for (const section of route.sections) {
    section.blocks.forEach((block, index) => {
      if (block.kind !== "quote") return;
      const problem = quoteAttributionProblem(block.attribution, rules);
      if (problem) {
        failures.push(
          `${route.route_id}: quote at sections.${section.section_id}.blocks[${index}] has an unsupported attribution "${block.attribution ?? ""}" (${problem})`,
        );
      }
    });
  }
  return failures;
}

export function routeRequirementChecklist(
  contractRoute: PageContentContractRoute,
): RouteRequirementChecklist {
  const corpus = buildFactCorpus(contractRoute.business_facts);
  return {
    route_id: contractRoute.route_id,
    section_ids: contractRoute.sections.map((section) => section.section_id),
    sections: contractRoute.sections.map((section) => ({
      section_id: section.section_id,
      is_faq: isFaqContractSection(section),
      min_words: SUBSTANCE_MIN_WORDS,
      entities: section.content_requirements.entities.filter((entity) => normalize(entity)),
      topics: section.content_requirements.topics
        .filter((topic) => normalize(topic))
        .map((topic) => ({ topic, tokens: significantTokens(topic) }))
        .filter((entry) => entry.tokens.length > 0),
      questions: [...section.content_requirements.questions],
      proofs: (section.proof_requirements ?? [])
        .filter((proof) => normalize(proof))
        .map((proof) => ({ proof, tokens: significantTokens(proof) })),
    })),
    internal_link_targets: contractRoute.internal_link_requirements.map(
      (link) => link.target_route_id,
    ),
    metadata: {
      title: [...contractRoute.metadata_requirements.title],
      description: [...contractRoute.metadata_requirements.description],
    },
    forbidden_claims: contractRoute.forbidden_claims.filter((claim) => normalize(claim)),
    placeholder_markers: PLACEHOLDER_MARKERS,
    ungrounded_claim_tokens: CREDENTIAL_CLAIM_TOKENS.filter((token) => !corpus.includes(token)),
    ungrounded_magnitude_phrases: MAGNITUDE_PHRASES.filter((phrase) => !corpus.includes(phrase)),
    verified_numbers: [...factNumbers(contractRoute.business_facts)],
    presentation_limits: { ...PRESENTATION_LIMITS },
    quote_attribution: quoteAttributionRules(contractRoute.business_facts),
  };
}

/** Every kind of requirement failure the deterministic validator can emit. */
export type RequirementFailureKind =
  | "route_identity"
  | "unexpected_section"
  | "missing_section"
  | "missing_metadata"
  | "missing_internal_link"
  | "unsupported_quantified_claim"
  | "unsupported_magnitude_claim"
  | "unsupported_credential_claim"
  | "forbidden_claim"
  | "placeholder_content"
  | "thin_section"
  | "missing_entity"
  | "missing_topic"
  | "duplicate_content"
  | "heading_restated"
  | "build_mechanics_in_copy"
  | "presentation_limit"
  | "unsupported_quote_attribution";

/** A validator message reduced to its kind and the exact subject it names. */
export interface ClassifiedRequirementFailure {
  kind: RequirementFailureKind;
  message: string;
  /** Section the failure is about, when the message names one. */
  section_id?: string;
  /** The exact phrase/term/target the message quotes. */
  subject?: string;
  /** For missing topics: the exact stemmed tokens the check did not find. */
  missing_tokens?: string[];
  /** For presentation limits: the field's word count and its limit. */
  word_count?: number;
  limit?: number;
}

/**
 * Patterns for every message the deterministic validator emits
 * (claim-grounding, content-validator structural checks, content-duplication).
 * The conformance test scans those modules' message templates and fails when
 * one does not match here — a new rule cannot ship without a checklist entry.
 */
export const REQUIREMENT_FAILURE_PATTERNS: ReadonlyArray<{
  kind: RequirementFailureKind;
  pattern: RegExp;
}> = [
  { kind: "route_identity", pattern: /: route_id does not match contract \(/ },
  { kind: "unexpected_section", pattern: /: unexpected section_id "([^"]*)" not in contract$/ },
  { kind: "missing_section", pattern: /: missing required section_id "([^"]*)"$/ },
  { kind: "missing_metadata", pattern: /: missing metadata\.(title|description)$/ },
  { kind: "missing_internal_link", pattern: /: missing required internal link to "([^"]*)"$/ },
  { kind: "unsupported_magnitude_claim", pattern: /: unsupported magnitude claim "([^"]*)"/ },
  {
    kind: "unsupported_credential_claim",
    pattern: /: unsupported credential\/guarantee claim "([^"]*)"/,
  },
  { kind: "unsupported_quantified_claim", pattern: /: unsupported [^"]+ claim "([^"]*)"/ },
  { kind: "forbidden_claim", pattern: /: contains forbidden claim "([^"]*)"$/ },
  { kind: "placeholder_content", pattern: /: contains placeholder content "([^"]*)"$/ },
  { kind: "thin_section", pattern: /: section "([^"]*)" has no substantive content$/ },
  { kind: "missing_entity", pattern: /: required entity "([^"]*)" is not represented$/ },
  {
    kind: "missing_topic",
    pattern: /: required topic "([^"]*)" is not covered \(missing: ([^)]*)\)$/,
  },
  { kind: "duplicate_content", pattern: /^DUPLICATE_CONTENT: / },
  { kind: "heading_restated", pattern: /^HEADING_RESTATED: / },
  { kind: "build_mechanics_in_copy", pattern: /^BUILD_MECHANICS_IN_COPY: .* says "([^"]*)"/ },
  {
    kind: "presentation_limit",
    pattern: /: (\S+) has (\S+) words \(limit (\S+)\)$/,
  },
  {
    kind: "unsupported_quote_attribution",
    pattern: /: quote at (\S+) has an unsupported attribution "(.*)" \(/,
  },
];

const SECTION_SCOPED_KINDS: ReadonlySet<RequirementFailureKind> = new Set([
  "unexpected_section",
  "missing_section",
  "thin_section",
]);

/** Reduce one validator message to its kind and subject; undefined when unknown. */
export function classifyRequirementFailure(
  message: string,
): ClassifiedRequirementFailure | undefined {
  for (const { kind, pattern } of REQUIREMENT_FAILURE_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const subject = match[1];
    const classified: ClassifiedRequirementFailure = { kind, message };
    if (subject !== undefined) {
      if (SECTION_SCOPED_KINDS.has(kind)) classified.section_id = subject;
      else classified.subject = subject;
    }
    if (kind === "presentation_limit") {
      classified.word_count = Number(match[2]);
      classified.limit = Number(match[3]);
    }
    if (kind === "missing_topic") {
      classified.missing_tokens = (match[2] ?? "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
    }
    return classified;
  }
  return undefined;
}

/**
 * Required entities must appear literally; required topics must have every
 * significant token represented somewhere in the route (phrasing is the
 * writer's, coverage is the contract's).
 */
function checkRequiredCoverage(
  routeId: string,
  checklist: RouteRequirementChecklist,
  haystack: string,
): string[] {
  const failures: string[] = [];
  const reportedTopics = new Set<string>();
  const reportedEntities = new Set<string>();

  for (const section of checklist.sections) {
    for (const entity of section.entities) {
      const normalized = normalize(entity);
      if (reportedEntities.has(normalized)) continue;
      if (!haystack.includes(normalized)) {
        reportedEntities.add(normalized);
        failures.push(`${routeId}: required entity "${entity}" is not represented`);
      }
    }
    for (const { topic, tokens } of section.topics) {
      const normalized = normalize(topic);
      if (reportedTopics.has(normalized)) continue;
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

/**
 * Proof requirements that are not token-covered in the matching generated
 * section. Same token rule as required topics: every significant token of
 * the proof phrase must appear in that section's prose.
 */
export function unsatisfiedProofRequirements(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): Set<string> {
  const missing = new Set<string>();
  for (const sectionRules of routeRequirementChecklist(contractRoute).sections) {
    const generated = route.sections.find(
      (section) => section.section_id === sectionRules.section_id,
    );
    const haystack = normalize(generated ? collectSectionProse(generated) : "");
    for (const { proof, tokens } of sectionRules.proofs) {
      const normalized = normalize(proof);
      const uncovered =
        tokens.length === 0
          ? !haystack.includes(normalized)
          : tokens.some((token) => !haystack.includes(token));
      if (uncovered) missing.add(normalized);
    }
  }
  return missing;
}
