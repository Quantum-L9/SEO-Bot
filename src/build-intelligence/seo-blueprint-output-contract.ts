/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEOContentBlueprint output contracts — the prompt shape is RENDERED from the
 * same zod schema that parses the reply, so the two cannot drift.
 *
 * Two live defects motivated this module: the batch prompt showed
 * `requirements` as an object while the schema required an array, and the
 * global-intent prompt asked for a bare top-level array (which
 * `response_format: json_object` cannot return) while nothing else in the run
 * used that shape. Each cost a bounded repair call on every run. Hand-written
 * shapes are gone: `renderOutputShape` walks the zod schema, and the only
 * hand-written text left is per-field guidance (`hints`), which must name a
 * field that exists — an unknown hint path throws, so a renamed or removed
 * field cannot leave stale guidance behind.
 *
 * Rendered leaf grammar (deterministic, parsed back by the conformance tests):
 *   "string" | "string[]" | "boolean" | "number" | "one of: a | b" |
 *   "array of (a | b)"   optionally followed by " — <hint>".
 * Objects render as objects; arrays of objects render as a one-element array.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from "zod";
import { type OutputShapeHints, renderOutputShape } from "./output-shape-renderer.js";
import { globalRouteIntentRouteSchema, seoContentBlueprintRoutesSchema } from "./schema-guards.js";

export {
  OUTPUT_SHAPE_HINT_SEPARATOR,
  OutputContractDriftError,
  type OutputShapeHints,
  renderOutputShape,
} from "./output-shape-renderer.js";

/* ── Global route intent plan (Phase A) ──────────────────────────────────────── */

/**
 * The Phase A reply is an OBJECT envelope `{ "routes": [...] }`. The provider
 * runs in `response_format: json_object` mode, which returns a JSON object —
 * the old bare-array prompt contradicted it and cost a repair every run.
 */
export const globalRouteIntentPlanSchema = z
  .object({ routes: z.array(globalRouteIntentRouteSchema) })
  .strict();

const GLOBAL_INTENT_HINTS: OutputShapeHints = {
  routes: {
    route_id: "exact route_id from routes above",
    primary_query: "the single primary target query",
    primary_intent: "top-level search intent",
  },
};

export function globalIntentOutputContract(): { shape: unknown; note: string } {
  return {
    shape: renderOutputShape(globalRouteIntentPlanSchema, GLOBAL_INTENT_HINTS),
    note:
      'Return a single JSON object whose only top-level key is "routes": exactly one entry per ' +
      "route_id above, in the requested order. No other fields. Every primary_query must be " +
      "unique after normalization.",
  };
}

/* ── Route batch (Phase B) ───────────────────────────────────────────────────── */

const seoContentBlueprintRouteSchema = seoContentBlueprintRoutesSchema.shape.routes.element;

/** Content-slot vocabulary, read from the schema that enforces it. */
export const SEO_BLUEPRINT_CONTENT_SLOTS: readonly string[] =
  seoContentBlueprintRouteSchema.shape.requirements.element.shape.target_slots.element.options;

const BATCH_CONTAINER_HINTS: OutputShapeHints = {
  routes:
    "the ONLY top-level key of the response; exactly one route object (route_shape) per route_id in the current_batch, in current_batch order",
};

const BATCH_ROUTE_HINTS: OutputShapeHints = {
  route_id: "reassert the route_id from the current_batch entry exactly",
  path: "reassert the path from the current_batch entry exactly",
  search_intent: {
    primary: "reassert the primary_intent from the global intent plan",
    journey_stage: "reassert the journey_stage from the global intent plan",
  },
  targets: {
    primary_query: "reassert the primary_query from the global intent plan",
  },
  requirements: {
    requirement_id: "unique within this route",
    target_slots: "at least one content slot",
    proof_needed:
      "only proof the verified business facts or honest methodology can support; never demand quantifiable achievements, third-party validation, client names, or credentials the facts cannot back",
  },
  internal_links: {
    target_route_id:
      "must be one of the all_route_index ids other than this route; other batches are valid targets",
  },
};

export function batchOutputContract(): {
  container: unknown;
  route_shape: unknown;
  content_slots: readonly string[];
} {
  return {
    container: renderOutputShape(seoContentBlueprintRoutesSchema, BATCH_CONTAINER_HINTS),
    route_shape: renderOutputShape(seoContentBlueprintRouteSchema, BATCH_ROUTE_HINTS),
    content_slots: SEO_BLUEPRINT_CONTENT_SLOTS,
  };
}
