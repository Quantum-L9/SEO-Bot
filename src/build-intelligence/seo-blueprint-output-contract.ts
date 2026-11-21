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
import { globalRouteIntentRouteSchema, seoContentBlueprintRoutesSchema } from "./schema-guards.js";

/** Separator between a rendered leaf type and its guidance text. */
export const OUTPUT_SHAPE_HINT_SEPARATOR = " — ";

/**
 * Per-field guidance. A string attaches to the node at that key; a nested
 * object descends into an object (or into the element of an array of
 * objects). A string on an array-of-objects node replaces its rendering with
 * `"array — <hint>"` (used for envelopes that point at a separately rendered
 * element shape).
 */
export interface OutputShapeHints {
  readonly [key: string]: string | OutputShapeHints;
}

/** A hint names a field the schema does not have, or a schema node is unsupported. */
export class OutputContractDriftError extends Error {
  readonly code = "SEO_BLUEPRINT_OUTPUT_CONTRACT_DRIFT";
  constructor(message: string) {
    super(message);
    this.name = "OutputContractDriftError";
  }
}

function withHint(type: string, hint: string | undefined): string {
  return hint ? `${type}${OUTPUT_SHAPE_HINT_SEPARATOR}${hint}` : type;
}

function leafType(schema: z.ZodTypeAny, path: string): string | undefined {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodEnum) return `one of: ${(schema.options as string[]).join(" | ")}`;
  if (schema instanceof z.ZodArray) {
    const element = schema.element as z.ZodTypeAny;
    if (element instanceof z.ZodString) return "string[]";
    if (element instanceof z.ZodEnum) {
      return `array of (${(element.options as string[]).join(" | ")})`;
    }
    if (element instanceof z.ZodObject) return undefined;
    throw new OutputContractDriftError(`unsupported array element at ${path || "$"}`);
  }
  if (schema instanceof z.ZodObject) return undefined;
  throw new OutputContractDriftError(
    `unsupported schema node ${schema.constructor.name} at ${path || "$"}`,
  );
}

function renderNode(
  schema: z.ZodTypeAny,
  hint: string | OutputShapeHints | undefined,
  path: string,
): unknown {
  if (schema instanceof z.ZodOptional) {
    const inner = renderNode(schema.unwrap() as z.ZodTypeAny, hint, path);
    return typeof inner === "string" ? `${inner} (optional)` : inner;
  }
  const leaf = leafType(schema, path);
  if (leaf !== undefined) {
    if (hint !== undefined && typeof hint !== "string") {
      throw new OutputContractDriftError(`nested hints given for leaf field ${path}`);
    }
    return withHint(leaf, hint);
  }
  if (schema instanceof z.ZodArray) {
    if (typeof hint === "string") return withHint("array", hint);
    return [renderNode(schema.element as z.ZodTypeAny, hint, `${path}[]`)];
  }
  const object = schema as z.ZodObject<z.ZodRawShape>;
  if (typeof hint === "string") {
    throw new OutputContractDriftError(`string hint given for object field ${path || "$"}`);
  }
  const shape = object.shape;
  for (const key of Object.keys(hint ?? {})) {
    if (!(key in shape)) {
      throw new OutputContractDriftError(
        `hint names field "${path ? `${path}.` : ""}${key}" that the schema does not have`,
      );
    }
  }
  const rendered: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    rendered[key] = renderNode(child as z.ZodTypeAny, hint?.[key], path ? `${path}.${key}` : key);
  }
  return rendered;
}

/** Render the prompt-facing output shape of `schema`, with optional field guidance. */
export function renderOutputShape(schema: z.ZodTypeAny, hints?: OutputShapeHints): unknown {
  return renderNode(schema, hints, "");
}

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
