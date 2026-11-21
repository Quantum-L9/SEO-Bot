/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Runtime schema guards (zod) for the LLM-produced portions of the build
 * intelligence artifacts.
 *
 * These mirror the model-decided fields of the shared @quantum-l9/bot-interop
 * contracts. The bot-interop TypeScript interfaces remain the single source of
 * truth for the sealed payload shape; these zod schemas exist only to VALIDATE
 * untrusted model output and to produce actionable messages for the one bounded
 * repair. Envelope/lineage fields (`schema`, `*_ref`, `validation`) are injected
 * deterministically by the producer — never by the model — and are not part of
 * these schemas.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type {
  ContentSlot,
  SEOContentBlueprintRoute,
  StructuredContentRoute,
} from "@quantum-l9/bot-interop";
import { z } from "zod";
import {
  keyPlacements,
  type OutputShapeHints,
  renderOutputRules,
  renderOutputShape,
} from "./output-shape-renderer.js";

const CONTENT_SLOTS: readonly [ContentSlot, ...ContentSlot[]] = [
  "primary_offer",
  "service_overview",
  "differentiation",
  "trust",
  "process",
  "project_proof",
  "local_relevance",
  "objection_handling",
  "faq",
  "conversion",
  "metadata",
];
const contentSlot = z.enum(CONTENT_SLOTS);
const strArray = z.array(z.string());

/* ── SEOContentBlueprint (model-produced routes) ────────────────────────────── */

const seoContentRequirement = z
  .object({
    requirement_id: z.string().min(1),
    target_slots: z.array(contentSlot),
    placement: z.enum(["FIRST_MATCH", "ALL_MATCHES"]),
    required_topics: strArray,
    required_entities: strArray,
    questions: strArray,
    proof_needed: strArray,
    required: z.boolean(),
  })
  .strict();

export const seoContentBlueprintRouteSchema = z
  .object({
    route_id: z.string().min(1),
    path: z.string().min(1),
    search_intent: z
      .object({
        primary: z.string().min(1),
        secondary: strArray,
        journey_stage: z.enum(["informational", "commercial", "transactional"]),
      })
      .strict(),
    targets: z
      .object({
        primary_query: z.string().min(1),
        supporting_queries: strArray,
        topics: strArray,
        entities: strArray,
      })
      .strict(),
    requirements: z.array(seoContentRequirement),
    competitive_gaps: z.array(
      z
        .object({
          gap_id: z.string().min(1),
          description: z.string(),
          donor_domains: strArray,
          opportunity: z.string(),
        })
        .strict(),
    ),
    internal_links: z.array(
      z
        .object({
          target_route_id: z.string().min(1),
          purpose: z.string(),
        })
        .strict(),
    ),
    aeo_geo: z
      .object({
        answer_targets: strArray,
        schema_requirements: strArray,
      })
      .strict(),
    metadata: z
      .object({
        title_requirements: strArray,
        description_requirements: strArray,
      })
      .strict(),
    forbidden_claims: strArray,
    acceptance_tests: strArray,
  })
  .strict();

export const seoContentBlueprintRoutesSchema = z
  .object({
    routes: z.array(seoContentBlueprintRouteSchema),
  })
  .strict();

// Compile-time guarantee that the zod route matches the bot-interop interface.
export type _SeoRouteParity =
  z.infer<typeof seoContentBlueprintRouteSchema> extends SEOContentBlueprintRoute ? true : never;

/* ── SEOContentBlueprint global route strategy (compact internal plan) ───────── */

/**
 * Compact internal global plan: the global planning call returns ONLY this
 * per-route intent summary — never full route blueprints. Internal to SEO-Bot;
 * it is not a cross-repo artifact. The producer parses an ARRAY of these and
 * validates exact route-set parity (count, ids, unique normalized queries)
 * deterministically — this schema owns the per-entry shape only.
 */
export const globalRouteIntentRouteSchema = z
  .object({
    route_id: z.string().min(1),
    primary_query: z.string().min(1),
    primary_intent: z.string().min(1),
    journey_stage: z.enum(["informational", "commercial", "transactional"]),
  })
  .strict();

export type GlobalRouteIntentRoute = z.infer<typeof globalRouteIntentRouteSchema>;

/* ── StructuredContentPackage (model-produced routes) ───────────────────────── */

/** One observed schema/JSON failure, shaped for the bounded repair prompt. */
export interface SchemaFailure {
  path: string;
  message: string;
}

/** Schema path of an issue, with array indexes collapsed to `[]` (`sections.6` → `sections[]`). */
function schemaPathOf(path: readonly (string | number)[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") rendered += "[]";
    else rendered = rendered ? `${rendered}.${segment}` : segment;
  }
  return rendered;
}

function describePlacement(path: string): string {
  return path.includes(".") || path.includes("[]")
    ? `\`${path}\``
    : `the route level (top-level key \`${path}\`)`;
}

/**
 * For an unrecognized key the schema accepts elsewhere, name where it belongs.
 * Read from the schema, so the hint can never point at a field that does not
 * exist. Empty when the key exists nowhere in the schema.
 */
function placementHint(
  keys: readonly string[],
  issuePath: readonly (string | number)[],
  placements: ReadonlyMap<string, readonly string[]>,
): string {
  const here = schemaPathOf(issuePath);
  const hints: string[] = [];
  for (const key of keys) {
    const own = here ? `${here}.${key}` : key;
    const elsewhere = (placements.get(key) ?? []).filter((at) => at !== own);
    if (elsewhere.length === 0) continue;
    hints.push(
      `"${key}" is not allowed here; it belongs ONLY at ${elsewhere.map(describePlacement).join(" or ")}. Move it there.`,
    );
  }
  return hints.length > 0 ? ` — ${hints.join(" ")}` : "";
}

/**
 * Normalize any parse/schema rejection into repair-prompt evidence. Zod errors
 * yield their per-issue path + message; anything else (JSON parse failures,
 * section-identity errors from the reconciler) becomes a single `$` failure so
 * the repair always receives exact, actionable evidence — never raw model
 * output (error messages here are already sanitized by the parsers).
 */
export function schemaFailureDetails(error: unknown, schema?: z.ZodTypeAny): SchemaFailure[] {
  if (error instanceof z.ZodError) {
    const placements = schema ? keyPlacements(schema) : undefined;
    return error.issues.map((issue) => {
      const path = issue.path.map(String).join(".") || "$";
      const placement =
        placements && issue.code === "unrecognized_keys"
          ? placementHint(issue.keys, issue.path, placements)
          : "";
      return { path, message: `${issue.message}${placement}` };
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{ path: "$", message }];
}

const contentBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraph"), text: z.string() }).strict(),
  z.object({ kind: z.literal("bullets"), items: strArray }).strict(),
  z.object({ kind: z.literal("steps"), items: strArray }).strict(),
  z
    .object({ kind: z.literal("quote"), text: z.string(), attribution: z.string().optional() })
    .strict(),
]);

export const structuredContentRouteSchema = z
  .object({
    route_id: z.string().min(1),
    path: z.string().min(1),
    metadata: z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
      })
      .strict(),
    sections: z.array(
      z
        .object({
          section_id: z.string().min(1),
          eyebrow: z.string().optional(),
          heading: z.string().optional(),
          subheading: z.string().optional(),
          blocks: z.array(contentBlock),
          cta: z.object({ label: z.string(), action: z.string() }).strict().optional(),
        })
        .strict(),
    ),
    faqs: z.array(z.object({ question: z.string(), answer: z.string() }).strict()),
    internal_links: z.array(
      z
        .object({
          target_route_id: z.string().min(1),
          anchor_text: z.string(),
        })
        .strict(),
    ),
    schema_content_inputs: z
      .object({
        faq: z.boolean().optional(),
        service: z.boolean().optional(),
        local_business: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/* ── Structured-content output contract (rendered from the schema) ─────────── */

/**
 * Field guidance for the rendered contract. Every key must name a field the
 * schema has: a renamed or removed field throws instead of leaving stale text.
 */
const STRUCTURED_CONTENT_HINTS: OutputShapeHints = {
  route_id: "the exact route_id from the contract",
  path: "the exact path from the contract",
  metadata: { title: "non-empty", description: "non-empty" },
  sections: { section_id: "the exact contract section_id" },
  faqs: {
    question:
      "FAQ question/answer pairs live ONLY here, in the route-level faqs array, never inside a section",
  },
  internal_links: { target_route_id: "include every required internal-link target" },
};

const sectionSchema = structuredContentRouteSchema.shape.sections.element;

/** Keys a section may carry, read from the schema that enforces them. */
export const STRUCTURED_CONTENT_SECTION_KEYS: readonly string[] = Object.keys(sectionSchema.shape);

/** Block kinds of the taught union, read from the schema. */
export const STRUCTURED_CONTENT_BLOCK_KINDS: readonly string[] = [
  ...sectionSchema.shape.blocks.element.options,
].map((option) => String(option.shape.kind.value));

const optionalSectionKeys = STRUCTURED_CONTENT_SECTION_KEYS.filter((key) =>
  sectionSchema.shape[key as keyof typeof sectionSchema.shape].isOptional(),
);

/**
 * Generation-prompt contract, RENDERED from `structuredContentRouteSchema` so
 * the prompt and the parser cannot drift. The zod schema remains FINAL
 * authority; this text only teaches it.
 *
 * Forbidden field aliases (`content`, `body`, `copy`, `html`, `paragraphs`)
 * are named explicitly: section prose must exist exclusively inside `blocks`.
 * FAQ placement is stated explicitly because the live QAP canary nested `faqs`
 * inside the FAQ section, which the strict schema rejects.
 */
export const STRUCTURED_CONTENT_OUTPUT_CONTRACT = [
  "Produce EXACTLY this JSON object (zod is final authority; this shape is rendered from it):",
  JSON.stringify(
    renderOutputShape(structuredContentRouteSchema, STRUCTURED_CONTENT_HINTS),
    null,
    2,
  ),
  "Rules:",
  "- sections: exactly one object per contract section_id, same ids, contract order.",
  `- A section may carry ONLY these keys: ${STRUCTURED_CONTENT_SECTION_KEYS.join(", ")}. No other key, ever.`,
  `- blocks: array of ONE kind per entry (kind is exactly one of: ${STRUCTURED_CONTENT_BLOCK_KINDS.join(", ")}) — the ONLY place section prose lives. The example shows one block of each kind.`,
  "- FAQ question/answer pairs belong ONLY in the route-level `faqs` array, never inside a section.",
  "  A section whose section_id is an FAQ section (e.g. faq) still carries only the allowed section",
  `  keys: blocks (intro prose, or []), plus optional ${optionalSectionKeys.join(", ")}.`,
  "  Never put a faqs key on a section.",
  "- internal_links: include every required internal-link target.",
  "- Never restate a heading, subheading or eyebrow as body copy or as a quote. Body copy says",
  "  something the heading does not.",
  "- A quote block needs an external attribution that appears in the contract's verified facts.",
  "  Never attribute a quote to the business itself; with no such attribution, use no quote.",
  "- Never repeat a paragraph, list item or FAQ answer within the route, nor any text listed",
  "  in already_used_on_earlier_routes. A component shared across routes (e.g. a process)",
  "  gets framing specific to this route, never the same paragraphs or steps.",
  "- Never mention how the site is built (endpoints, webhooks, HTTPS, pipelines that build the",
  "  site, placeholder or invented details) in customer copy. State availability plainly.",
  ...renderOutputRules(structuredContentRouteSchema, STRUCTURED_CONTENT_HINTS).map(
    (rule) => `- ${rule}`,
  ),
  'Spell every non-string value exactly as an allowed value (for example "kind": "paragraph");',
  "CHOOSE which allowed value is true for this route: booleans may be true or false, and an",
  'example value is never a default. Write your content only over the "string" placeholders.',
  "FORBIDDEN field aliases: content, body, copy, html, paragraphs. Section prose exists",
  "exclusively inside blocks. sections[].blocks is REQUIRED on EVERY section — never",
  "omit it, not even on the last section; a section with nothing to say still",
  "carries blocks: []. Respond with ONLY the JSON object — no markdown fences.",
].join("\n");

export type _StructuredRouteParity =
  z.infer<typeof structuredContentRouteSchema> extends StructuredContentRoute ? true : never;

/* ── Semantic content-validation verdict (model-produced) ───────────────────── */

export const contentValidationVerdictSchema = z
  .object({
    seo_blueprint_passed: z.boolean(),
    contract_passed: z.boolean(),
    unsupported_claims: strArray,
    failed_requirements: strArray,
  })
  .strict();

export type ContentValidationVerdict = z.infer<typeof contentValidationVerdictSchema>;
