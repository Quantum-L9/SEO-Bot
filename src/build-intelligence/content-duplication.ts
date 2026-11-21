/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Structured-content duplication and copy-hygiene checks — deterministic,
 * evaluated on each generated route before it is accepted.
 *
 * The definition matches Website-Bot's rendered site-quality checker, so a
 * route accepted here does not fail there for the same reason:
 *   - near duplicate: two units of at least DUPLICATE_MIN_WORDS words whose
 *     word 3-shingle Jaccard similarity is at least DUPLICATE_SIMILARITY;
 *   - cross-page duplicate: the same (or near-same) unit on two routes.
 *
 * The QAP canary (qap-canary5) failed that checker with 13 findings: an H1
 * restated as a self-attributed quote, process-step paragraphs repeated on
 * three routes, and /contact copy that described the build ("verified HTTPS
 * lead endpoint", "invented contact details").
 *
 * Findings are repair evidence. Nothing here deletes or rewrites content.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { PageContentContractRoute, StructuredContentRoute } from "@quantum-l9/bot-interop";
import { buildFactCorpus } from "./claim-grounding.js";

/** Units shorter than this are never compared (checker parity). */
export const DUPLICATE_MIN_WORDS = 8;
/** Word 3-shingle Jaccard similarity at or above which two units are duplicates. */
export const DUPLICATE_SIMILARITY = 0.6;
/** Shingle width, in words. */
const SHINGLE_WORDS = 3;

/**
 * Vocabulary that describes how the site is built rather than the business.
 * A term is allowed only when a verified business fact uses it (a developer
 * tools client may genuinely sell endpoints).
 */
export const BUILD_MECHANICS_TERMS: readonly string[] = [
  "endpoint",
  "webhook",
  "https",
  "invented",
  "placeholder",
];

/** Copy that only frames or labels content; never body copy itself. */
type HeadingKind = "heading" | "subheading" | "eyebrow";
/** Copy a visitor reads as body text. */
type BodyKind = "paragraph" | "quote" | "item" | "faq_answer";

export interface ContentUnit {
  route_id: string;
  /** Where in the route, e.g. `sections.hero.blocks[1]` or `faqs[0].answer`. */
  location: string;
  kind: HeadingKind | BodyKind;
  text: string;
}

const HEADING_KINDS: ReadonlySet<string> = new Set(["heading", "subheading", "eyebrow"]);

export function isHeadingUnit(unit: ContentUnit): boolean {
  return HEADING_KINDS.has(unit.kind);
}

/** Lowercased word tokens: letters and digits only, punctuation dropped. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function shingles(words: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index++) {
    set.add(words.slice(index, index + SHINGLE_WORDS).join(" "));
  }
  return set;
}

/**
 * Word 3-shingle Jaccard similarity of two texts, or null when either is
 * shorter than DUPLICATE_MIN_WORDS (such pairs are never compared).
 */
export function shingleSimilarity(left: string, right: string): number | null {
  const leftWords = contentWords(left);
  const rightWords = contentWords(right);
  if (leftWords.length < DUPLICATE_MIN_WORDS || rightWords.length < DUPLICATE_MIN_WORDS) {
    return null;
  }
  const a = shingles(leftWords);
  const b = shingles(rightWords);
  let shared = 0;
  for (const shingle of a) if (b.has(shingle)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function blockUnits(routeId: string, location: string, block: unknown): ContentUnit[] {
  const value = block as { kind?: unknown; text?: unknown; items?: unknown };
  if ((value.kind === "paragraph" || value.kind === "quote") && typeof value.text === "string") {
    return [{ route_id: routeId, location, kind: value.kind, text: value.text }];
  }
  if ((value.kind === "bullets" || value.kind === "steps") && Array.isArray(value.items)) {
    return value.items
      .filter((item): item is string => typeof item === "string")
      .map((item, index) => ({
        route_id: routeId,
        location: `${location}.items[${index}]`,
        kind: "item" as const,
        text: item,
      }));
  }
  return [];
}

/** Every heading and body unit of a route, in reading order. */
export function contentUnits(route: StructuredContentRoute): ContentUnit[] {
  const units: ContentUnit[] = [];
  for (const section of route.sections) {
    const at = `sections.${section.section_id}`;
    for (const kind of ["eyebrow", "heading", "subheading"] as const) {
      const text = section[kind];
      if (typeof text === "string" && text.trim()) {
        units.push({ route_id: route.route_id, location: `${at}.${kind}`, kind, text });
      }
    }
    section.blocks.forEach((block, index) => {
      units.push(...blockUnits(route.route_id, `${at}.blocks[${index}]`, block));
    });
  }
  route.faqs.forEach((faq, index) => {
    units.push({
      route_id: route.route_id,
      location: `faqs[${index}].answer`,
      kind: "faq_answer",
      text: faq.answer,
    });
  });
  return units;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function duplicateFinding(unit: ContentUnit, other: ContentUnit, similarity: number): string {
  const where =
    other.route_id === unit.route_id
      ? other.location
      : `route "${other.route_id}" ${other.location}`;
  if (isHeadingUnit(other)) {
    return (
      `HEADING_RESTATED: ${unit.location} (${unit.kind}) restates the ${other.kind} at ${where} ` +
      `(${percent(similarity)} 3-word-shingle similarity, limit ${percent(DUPLICATE_SIMILARITY)}): ` +
      `"${snippet(unit.text)}". Never repeat a heading as body copy or as a quote; write new body copy.`
    );
  }
  return (
    `DUPLICATE_CONTENT: ${unit.location} (${unit.kind}) repeats ${where} ` +
    `(${percent(similarity)} 3-word-shingle similarity, limit ${percent(DUPLICATE_SIMILARITY)}): ` +
    `"${snippet(unit.text)}". Rewrite it with wording specific to this route and section.`
  );
}

function mechanicsFindings(units: readonly ContentUnit[], factCorpus: string): string[] {
  const findings: string[] = [];
  for (const unit of units) {
    const words = new Set(contentWords(unit.text));
    for (const term of BUILD_MECHANICS_TERMS) {
      if (words.has(term) && !factCorpus.includes(term)) {
        findings.push(
          `BUILD_MECHANICS_IN_COPY: ${unit.location} says "${term}", which describes how the site ` +
            `is built, not the business: "${snippet(unit.text)}". Remove it and state availability plainly.`,
        );
      }
    }
  }
  return findings;
}

/**
 * Every duplication and copy-hygiene finding for one generated route, as
 * repair evidence. `accepted` holds the units of routes already accepted
 * earlier in the same package (generation is sequential per route).
 */
export function findContentFindings(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
  accepted: readonly ContentUnit[],
): string[] {
  const units = contentUnits(route);
  const body = units.filter((unit) => !isHeadingUnit(unit));
  const headings = units.filter(isHeadingUnit);
  const findings: string[] = [];

  body.forEach((unit, index) => {
    // Within the route: an earlier body unit, or any heading, restated.
    const earlier = [...headings, ...body.slice(0, index)];
    // Across routes: anything an earlier accepted route already said.
    for (const other of [...earlier, ...accepted]) {
      const similarity = shingleSimilarity(unit.text, other.text);
      if (similarity !== null && similarity >= DUPLICATE_SIMILARITY) {
        findings.push(duplicateFinding(unit, other, similarity));
        break;
      }
    }
  });

  findings.push(
    ...mechanicsFindings(units, buildFactCorpus(contractRoute.business_facts).toLowerCase()),
  );
  return findings;
}
