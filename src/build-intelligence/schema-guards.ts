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

/**
 * Reusable generation-prompt contract, kept adjacent to the runtime schema
 * guard it teaches. The zod schema above/below remains FINAL authority — this
 * text exists only so the generation prompt teaches the exact shape instead of
 * letting the model invent `content: "..."` in place of the blocks union.
 *
 * Forbidden field aliases (`content`, `body`, `copy`, `html`, `paragraphs`)
 * are named explicitly: section prose must exist exclusively inside `blocks`.
 * The strict zod schema rejects every alias anyway; the prompt contract makes
 * the first generation far more likely to be right, which is what keeps a
 * route inside its two-call generation budget.
 */
export const STRUCTURED_CONTENT_OUTPUT_CONTRACT = [
  "Produce EXACTLY this JSON object (zod is final authority; this text only teaches it):",
  "- route_id: string — the exact route_id from the contract.",
  "- path: string — the exact path from the contract.",
  "- metadata: { title: string, description: string } — both non-empty.",
  "- sections: array — exactly one object per contract section_id, same ids, contract order. Each:",
  "  - section_id: string — the exact contract section_id.",
  "  - eyebrow: string (optional), heading: string (optional), subheading: string (optional).",
  "  - blocks: array of ONE kind per entry — the ONLY place section prose lives:",
  '    - { kind: "paragraph", text: string }',
  '    - { kind: "bullets", items: string[] }',
  '    - { kind: "steps", items: string[] }',
  '    - { kind: "quote", text: string, attribution: string (optional) }',
  "  - cta (optional): { label: string, action: string }.",
  "- faqs: array of { question: string, answer: string }.",
  "- internal_links: array of { target_route_id: string, anchor_text: string } — include every required target.",
  "- schema_content_inputs: object with optional booleans faq, service, local_business.",
  "FORBIDDEN field aliases: content, body, copy, html, paragraphs. Section prose exists",
  "exclusively inside blocks. sections[].blocks is REQUIRED on EVERY section — never",
  "omit it, not even on the last section; a section with nothing to say still",
  "carries blocks: []. Respond with ONLY the JSON object — no markdown fences.",
].join("\n");

/** One observed schema/JSON failure, shaped for the bounded repair prompt. */
export interface SchemaFailure {
  path: string;
  message: string;
}

/**
 * Normalize any parse/schema rejection into repair-prompt evidence. Zod errors
 * yield their per-issue path + message; anything else (JSON parse failures,
 * section-identity errors from the reconciler) becomes a single `$` failure so
 * the repair always receives exact, actionable evidence — never raw model
 * output (error messages here are already sanitized by the parsers).
 */
export function schemaFailureDetails(error: unknown): SchemaFailure[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "$",
      message: issue.message,
    }));
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
