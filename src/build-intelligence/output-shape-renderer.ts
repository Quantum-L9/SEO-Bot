/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Output-shape renderer — turns a zod schema into the prompt-facing shape the
 * model is taught, so the prompt and the parser cannot drift.
 *
 * Generalised from the SEOContentBlueprint contract (which re-exports it
 * unchanged) so the structured-content contract can be rendered the same way.
 * It lives in its own module because `schema-guards.ts` renders its own
 * contract from it, while the blueprint contract module imports
 * `schema-guards.ts`; a shared home avoids that import cycle.
 *
 * Rendered leaf grammar (deterministic, parsed back by the conformance tests):
 *   "string" | "string[]" | "boolean" | "number" | "one of: a | b" |
 *   "array of (a | b)" | "literal: x"   optionally followed by " — <hint>",
 *   and " (optional)" on optional leaves.
 * Objects render as objects; arrays of objects render as a one-element array;
 * a discriminated union renders as `{ "one of": [variant, ...] }`.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from "zod";

/** Separator between a rendered leaf type and its guidance text. */
export const OUTPUT_SHAPE_HINT_SEPARATOR = " — ";

/** Key under which a discriminated union lists its rendered variants. */
export const OUTPUT_SHAPE_UNION_KEY = "one of";

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
  if (schema instanceof z.ZodLiteral) return `literal: ${String(schema.value)}`;
  if (schema instanceof z.ZodEnum) return `one of: ${(schema.options as string[]).join(" | ")}`;
  if (schema instanceof z.ZodArray) {
    const element = schema.element as z.ZodTypeAny;
    if (element instanceof z.ZodString) return "string[]";
    if (element instanceof z.ZodEnum) {
      return `array of (${(element.options as string[]).join(" | ")})`;
    }
    if (element instanceof z.ZodObject || element instanceof z.ZodDiscriminatedUnion) {
      return undefined;
    }
    throw new OutputContractDriftError(`unsupported array element at ${path || "$"}`);
  }
  if (schema instanceof z.ZodObject || schema instanceof z.ZodDiscriminatedUnion) return undefined;
  throw new OutputContractDriftError(
    `unsupported schema node ${schema.constructor.name} at ${path || "$"}`,
  );
}

function renderLeaf(
  leaf: string,
  hint: string | OutputShapeHints | undefined,
  path: string,
): string {
  if (hint !== undefined && typeof hint !== "string") {
    throw new OutputContractDriftError(`nested hints given for leaf field ${path}`);
  }
  return withHint(leaf, hint);
}

/** Variants of a discriminated union, in declaration order. */
function unionVariants(
  union: z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
): z.ZodObject<z.ZodRawShape>[] {
  return [...union.options] as z.ZodObject<z.ZodRawShape>[];
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
  if (leaf !== undefined) return renderLeaf(leaf, hint, path);
  if (schema instanceof z.ZodArray) {
    if (typeof hint === "string") return withHint("array", hint);
    return [renderNode(schema.element as z.ZodTypeAny, hint, `${path}[]`)];
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (hint !== undefined) {
      throw new OutputContractDriftError(`hints are not supported on union ${path || "$"}`);
    }
    return {
      [OUTPUT_SHAPE_UNION_KEY]: unionVariants(schema).map((variant) =>
        renderObject(variant, undefined, path),
      ),
    };
  }
  return renderObject(schema as z.ZodObject<z.ZodRawShape>, hint, path);
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function renderObject(
  object: z.ZodObject<z.ZodRawShape>,
  hint: string | OutputShapeHints | undefined,
  path: string,
): Record<string, unknown> {
  if (typeof hint === "string") {
    throw new OutputContractDriftError(`string hint given for object field ${path || "$"}`);
  }
  const shape = object.shape;
  for (const key of Object.keys(hint ?? {})) {
    if (!(key in shape)) {
      const field = childPath(path, key);
      throw new OutputContractDriftError(
        `hint names field "${field}" that the schema does not have`,
      );
    }
  }
  const rendered: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    rendered[key] = renderNode(child as z.ZodTypeAny, hint?.[key], childPath(path, key));
  }
  return rendered;
}

/** Render the prompt-facing output shape of `schema`, with optional field guidance. */
export function renderOutputShape(schema: z.ZodTypeAny, hints?: OutputShapeHints): unknown {
  return renderNode(schema, hints, "");
}

/* ── Key placement index ─────────────────────────────────────────────────────── */

/**
 * Every place each object key may appear in `schema`, as dotted paths with
 * `[]` marking an array element (e.g. `faqs`, `sections[].blocks[].items`).
 * Used to tell a model where an unrecognized key actually belongs.
 */
export function keyPlacements(schema: z.ZodTypeAny): ReadonlyMap<string, readonly string[]> {
  const placements = new Map<string, string[]>();
  const visit = (node: z.ZodTypeAny, path: string): void => {
    if (node instanceof z.ZodOptional) {
      visit(node.unwrap() as z.ZodTypeAny, path);
      return;
    }
    if (node instanceof z.ZodArray) {
      visit(node.element as z.ZodTypeAny, `${path}[]`);
      return;
    }
    if (node instanceof z.ZodDiscriminatedUnion) {
      for (const variant of unionVariants(node)) visit(variant, path);
      return;
    }
    if (!(node instanceof z.ZodObject)) return;
    for (const [key, child] of Object.entries(node.shape as z.ZodRawShape)) {
      const at = childPath(path, key);
      const list = placements.get(key) ?? [];
      if (!list.includes(at)) list.push(at);
      placements.set(key, list);
      visit(child as z.ZodTypeAny, at);
    }
  };
  visit(schema, "");
  return placements;
}
