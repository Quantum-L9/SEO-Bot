/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * A model copies the rendered contract. The QAP canary copied
 * `"kind": "literal: paragraph"` verbatim and every block failed the
 * discriminator. These tests copy every rendered contract VERBATIM, with no
 * translation and no placeholder substitution, and require the schema to
 * accept the copy. Any leaf that describes a value instead of showing it
 * ("literal: x", "one of: a | b", "boolean", "string[]") fails here.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { STRING_PLACEHOLDER } from "../../src/build-intelligence/output-shape-renderer.js";
import {
  STRUCTURED_CONTENT_OUTPUT_CONTRACT,
  seoContentBlueprintRoutesSchema,
  structuredContentRouteSchema,
} from "../../src/build-intelligence/schema-guards.js";
import {
  batchOutputContract,
  globalIntentOutputContract,
  globalRouteIntentPlanSchema,
} from "../../src/build-intelligence/seo-blueprint-output-contract.js";

/** The JSON example embedded in the structured-content contract text. */
function structuredShape(): unknown {
  const text = STRUCTURED_CONTENT_OUTPUT_CONTRACT;
  return JSON.parse(text.slice(text.indexOf("{"), text.indexOf("\nRules:")));
}

const routeShape = batchOutputContract().route_shape;

const CONTRACTS: Array<[string, () => unknown, z.ZodTypeAny]> = [
  ["global intent", () => globalIntentOutputContract().shape, globalRouteIntentPlanSchema],
  ["batch container", () => batchOutputContract().container, seoContentBlueprintRoutesSchema],
  ["batch route", () => ({ routes: [routeShape] }), seoContentBlueprintRoutesSchema],
  ["structured content", structuredShape, structuredContentRouteSchema],
];

/** Every string leaf and every object key in a rendered shape. */
function walk(node: unknown, out: { strings: string[]; keys: string[] }): typeof out {
  if (Array.isArray(node)) for (const element of node) walk(element, out);
  else if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      out.keys.push(key);
      walk(child, out);
    }
  } else if (typeof node === "string") out.strings.push(node);
  return out;
}

describe("rendered output contracts can be copied verbatim", () => {
  it.each(CONTRACTS)("%s: a verbatim copy parses with the schema", (_name, shape, schema) => {
    const copy = structuredClone(shape());
    const result = schema.safeParse(copy);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(CONTRACTS)("%s: no rendered value describes a value", (_name, shape) => {
    const { strings, keys } = walk(shape(), { strings: [], keys: [] });
    expect(keys).not.toContain("one of");
    for (const value of strings) {
      expect(value).not.toMatch(/^(literal:|one of|array of|boolean|number)/);
      expect(value).not.toBe("string[]");
    }
  });

  it.each(CONTRACTS.filter(([name]) => name !== "batch container"))(
    "%s: exact values are never confused with placeholders",
    (_name, shape) => {
      const { strings } = walk(shape(), { strings: [], keys: [] });
      const exact = strings.filter((value) => !value.startsWith(STRING_PLACEHOLDER));
      // Every non-placeholder string is an enum option or discriminator the schema accepts;
      // the verbatim-copy test above proves it, this one proves they exist at all.
      expect(exact.length).toBeGreaterThan(0);
    },
  );

  it("structured content shows each block kind as its exact value", () => {
    const shape = structuredShape() as { sections: Array<{ blocks: Array<{ kind: unknown }> }> };
    expect(shape.sections[0]?.blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "bullets",
      "steps",
      "quote",
    ]);
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
      'chosen by its "kind" value, which must be exactly one of: paragraph, bullets, steps, quote.',
    );
  });

  it("every boolean is taught as a choice, never as a default (review: copying true claims every JSON-LD input)", () => {
    for (const flag of ["faq", "service", "local_business"]) {
      expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
        `schema_content_inputs.${flag}: true or false — choose the value that is actually true`,
      );
    }
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain("example value is never a default");
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).not.toContain("Copy every non-string value");
    expect(batchOutputContract().rules).toContain(
      "route_shape.requirements[].required: true or false — choose the value that is actually true; the example's value is not a default.",
    );
  });

  it("blueprint contracts carry allowed values as rules, not as values", () => {
    expect(globalIntentOutputContract().rules).toContain(
      "routes[].journey_stage: exactly one of: informational, commercial, transactional.",
    );
    expect(batchOutputContract().rules).toContain(
      "route_shape.requirements[].placement: exactly one of: FIRST_MATCH, ALL_MATCHES.",
    );
  });
});
