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
 * Shared by the SEOContentBlueprint contracts (which re-export it) and the
 * structured-content contract. It lives in its own module because
 * `schema-guards.ts` renders its contract from it while the blueprint contract
 * module imports `schema-guards.ts`.
 *
 * The rendered shape is an EXAMPLE DOCUMENT: a model that copies it verbatim
 * produces a value the schema accepts. A model copies what it sees, so no leaf
 * may DESCRIBE a value. The QAP canary copied `"kind": "literal: paragraph"`
 * verbatim, and every block failed the discriminator.
 *
 *   string          → "string", "string (optional)" or "string — <hint>":
 *                     a placeholder that is itself a valid string, written over
 *                     with content
 *   string[]        → ["string"]           boolean → true      number → 0
 *   literal         → its exact JSON value
 *   enum            → its first option, exactly
 *   enum[]          → [first option]
 *   object          → an object of rendered children
 *   object[]        → a one-element array
 *   union[]         → one concrete example object per variant, each with its
 *                     exact discriminator value
 *
 * Everything that is guidance rather than a value goes to `renderOutputRules`:
 * allowed enum and discriminator values, hints on non-string fields, and
 * optional fields, each as one plain sentence.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from "zod";

/** Separator between a rendered leaf type and its guidance text. */
export const OUTPUT_SHAPE_HINT_SEPARATOR = " — ";

/** Prefix of every string placeholder. No exact value may start with it. */
export const STRING_PLACEHOLDER = "string";

/**
 * Per-field guidance. A string attaches to the node at that key; a nested
 * object descends into an object (or into the element of an array of
 * objects). A string on an array of objects renders the array as `[]` and
 * moves the hint into the rules (used for envelopes whose element shape is
 * rendered separately).
 */
export interface OutputShapeHints {
  readonly [key: string]: string | OutputShapeHints;
}

type FieldHint = string | OutputShapeHints | undefined;

/** A hint names a field the schema does not have, or a schema node is unsupported. */
export class OutputContractDriftError extends Error {
  readonly code = "SEO_BLUEPRINT_OUTPUT_CONTRACT_DRIFT";
  constructor(message: string) {
    super(message);
    this.name = "OutputContractDriftError";
  }
}

interface RenderState {
  rules: string[];
  optional: string[];
}

function at(path: string): string {
  return path || "$";
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function placeholder(hint: string | undefined): string {
  return hint ? `${STRING_PLACEHOLDER}${OUTPUT_SHAPE_HINT_SEPARATOR}${hint}` : STRING_PLACEHOLDER;
}

/** An exact value must never be mistaken for a string placeholder. */
function exactValue(value: unknown, path: string): unknown {
  if (typeof value === "string" && value.startsWith(STRING_PLACEHOLDER)) {
    throw new OutputContractDriftError(
      `exact value "${value}" at ${at(path)} collides with the string placeholder`,
    );
  }
  return value;
}

function leafHint(hint: FieldHint, path: string): string | undefined {
  if (hint !== undefined && typeof hint !== "string") {
    throw new OutputContractDriftError(`nested hints given for leaf field ${path}`);
  }
  return hint;
}

/** A hint on a field whose example value is not a string becomes a rule. */
function ruleHint(state: RenderState, hint: FieldHint, path: string): void {
  const text = leafHint(hint, path);
  if (text) state.rules.push(`${at(path)}: ${text}.`);
}

function enumOptions(schema: z.ZodEnum<[string, ...string[]]>): string[] {
  return [...(schema.options as string[])];
}

/** Variants of a discriminated union, in declaration order. */
function unionVariants(
  union: z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
): z.ZodObject<z.ZodRawShape>[] {
  return [...union.options] as z.ZodObject<z.ZodRawShape>[];
}

/** One example object per variant, plus the sentence naming the allowed values. */
function renderUnion(
  union: z.ZodDiscriminatedUnion<string, z.ZodDiscriminatedUnionOption<string>[]>,
  hint: FieldHint,
  path: string,
  state: RenderState,
): Record<string, unknown>[] {
  if (hint !== undefined) {
    throw new OutputContractDriftError(`hints are not supported on union ${at(path)}`);
  }
  const variants = unionVariants(union);
  const discriminator = union.discriminator;
  const values = variants.map((variant) =>
    String((variant.shape[discriminator] as z.ZodLiteral<unknown>).value),
  );
  state.rules.push(
    `${at(path)}: each entry is exactly one of the ${variants.length} example objects shown, ` +
      `chosen by its "${discriminator}" value, which must be exactly one of: ${values.join(", ")}. ` +
      "Use only the keys of the matching example.",
  );
  return variants.map((variant) => renderObject(variant, undefined, path, state, discriminator));
}

function renderArray(
  schema: z.ZodArray<z.ZodTypeAny>,
  hint: FieldHint,
  path: string,
  state: RenderState,
): unknown[] {
  const element = schema.element as z.ZodTypeAny;
  const elementPath = `${path}[]`;
  if (element instanceof z.ZodString) return [placeholder(leafHint(hint, path))];
  if (element instanceof z.ZodEnum) {
    const options = enumOptions(element);
    state.rules.push(`${at(elementPath)}: each entry is exactly one of: ${options.join(", ")}.`);
    ruleHint(state, hint, path);
    return [exactValue(options[0], elementPath)];
  }
  if (element instanceof z.ZodDiscriminatedUnion) {
    return renderUnion(element, hint, elementPath, state);
  }
  if (element instanceof z.ZodObject) {
    if (typeof hint === "string") {
      state.rules.push(`${at(path)}: ${hint}.`);
      return [];
    }
    return [renderObject(element, hint, elementPath, state)];
  }
  throw new OutputContractDriftError(`unsupported array element at ${at(path)}`);
}

function renderNode(
  schema: z.ZodTypeAny,
  hint: FieldHint,
  path: string,
  state: RenderState,
  discriminator = false,
): unknown {
  if (schema instanceof z.ZodOptional) {
    state.optional.push(at(path));
    const inner = renderNode(schema.unwrap() as z.ZodTypeAny, hint, path, state);
    return typeof inner === "string" && inner.startsWith(STRING_PLACEHOLDER)
      ? `${inner} (optional)`
      : inner;
  }
  if (schema instanceof z.ZodString) return placeholder(leafHint(hint, path));
  if (schema instanceof z.ZodBoolean) {
    ruleHint(state, hint, path);
    return true;
  }
  if (schema instanceof z.ZodNumber) {
    ruleHint(state, hint, path);
    return 0;
  }
  if (schema instanceof z.ZodLiteral) {
    ruleHint(state, hint, path);
    if (!discriminator)
      state.rules.push(`${at(path)}: always exactly ${JSON.stringify(schema.value)}.`);
    return exactValue(schema.value, path);
  }
  if (schema instanceof z.ZodEnum) {
    const options = enumOptions(schema);
    state.rules.push(`${at(path)}: exactly one of: ${options.join(", ")}.`);
    ruleHint(state, hint, path);
    return exactValue(options[0], path);
  }
  if (schema instanceof z.ZodArray) return renderArray(schema, hint, path, state);
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return renderUnion(schema, hint, path, state)[0];
  }
  if (schema instanceof z.ZodObject) return renderObject(schema, hint, path, state);
  throw new OutputContractDriftError(
    `unsupported schema node ${schema.constructor.name} at ${at(path)}`,
  );
}

function renderObject(
  object: z.ZodObject<z.ZodRawShape>,
  hint: FieldHint,
  path: string,
  state: RenderState,
  discriminatorKey?: string,
): Record<string, unknown> {
  if (typeof hint === "string") {
    throw new OutputContractDriftError(`string hint given for object field ${at(path)}`);
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
    rendered[key] = renderNode(
      child as z.ZodTypeAny,
      hint?.[key],
      childPath(path, key),
      state,
      key === discriminatorKey,
    );
  }
  return rendered;
}

function render(
  schema: z.ZodTypeAny,
  hints?: OutputShapeHints,
): {
  shape: unknown;
  state: RenderState;
} {
  const state: RenderState = { rules: [], optional: [] };
  return { shape: renderNode(schema, hints, "", state), state };
}

/** Render the prompt-facing example document of `schema`, with optional field guidance. */
export function renderOutputShape(schema: z.ZodTypeAny, hints?: OutputShapeHints): unknown {
  return render(schema, hints).shape;
}

/**
 * The guidance that is not a value, one plain sentence each: allowed enum and
 * discriminator values, hints on non-string fields, and the optional fields.
 */
export function renderOutputRules(schema: z.ZodTypeAny, hints?: OutputShapeHints): string[] {
  const { state } = render(schema, hints);
  const optional = [...new Set(state.optional)];
  return [
    ...new Set(state.rules),
    ...(optional.length > 0
      ? [`Optional fields (may be omitted; never add other keys): ${optional.join(", ")}.`]
      : []),
  ];
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
