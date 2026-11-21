/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { FIRST_PARTY_AUTHORITY_SCHEMA } from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { seoContentBlueprintRoutesSchema } from "../../src/build-intelligence/schema-guards.js";
import {
  batchOutputContract,
  globalIntentOutputContract,
  globalRouteIntentPlanSchema,
  OutputContractDriftError,
  renderOutputRules,
  renderOutputShape,
  SEO_BLUEPRINT_CONTENT_SLOTS,
} from "../../src/build-intelligence/seo-blueprint-output-contract.js";
import {
  createSEOContentBlueprint,
  SEO_CONTENT_BLUEPRINT_BATCH_INVALID_CODE,
  SeoContentBlueprintBatchInvalidError,
} from "../../src/build-intelligence/seo-content-blueprint.js";
import type { LlmService } from "../../src/services/llm.js";
import {
  answerBlueprintPrompt,
  exampleFromOutputShape,
} from "./fixtures/contract-following-model.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("renderOutputShape — the prompt shape is generated from the parsing schema", () => {
  it("renders arrays of objects as arrays (regression: requirements was shown as an object)", () => {
    const routeShape = batchOutputContract().route_shape as Record<string, unknown>;
    expect(Array.isArray(routeShape.requirements)).toBe(true);
    expect(Array.isArray(routeShape.competitive_gaps)).toBe(true);
    expect(Array.isArray(routeShape.internal_links)).toBe(true);
  });

  it("renders the global intent plan as an object envelope (regression: prompt asked for a bare array)", () => {
    const { shape } = globalIntentOutputContract();
    expect(Array.isArray(shape)).toBe(false);
    expect(Object.keys(shape as object)).toEqual(["routes"]);
    expect(Array.isArray((shape as { routes: unknown }).routes)).toBe(true);
    // A bare array — what the old prompt asked for — is now rejected.
    expect(() => globalRouteIntentPlanSchema.parse([])).toThrow();
  });

  it("derives the content-slot vocabulary from the schema enum", () => {
    expect(SEO_BLUEPRINT_CONTENT_SLOTS).toContain("primary_offer");
    expect(SEO_BLUEPRINT_CONTENT_SLOTS).toHaveLength(11);
  });

  it("rejects a hint for a field the schema does not have (stale guidance cannot survive a rename)", () => {
    const schema = z.object({ a: z.string(), nested: z.object({ b: z.boolean() }) }).strict();
    expect(() => renderOutputShape(schema, { missing: "x" })).toThrow(OutputContractDriftError);
    expect(() => renderOutputShape(schema, { nested: { gone: "x" } })).toThrow(/nested\.gone/);
    expect(() => renderOutputShape(schema, { a: { deeper: "x" } })).toThrow(
      OutputContractDriftError,
    );
  });

  it("refuses schema nodes it cannot render instead of guessing", () => {
    expect(() => renderOutputShape(z.object({ when: z.date() }))).toThrow(OutputContractDriftError);
  });

  it("renders copyable values; allowed values and non-string hints go to the rules", () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.enum(["x", "y"]),
      c: z.array(z.string()),
      d: z.boolean(),
      e: z.literal("fixed"),
    });
    expect(renderOutputShape(schema, { b: "pick one" })).toEqual({
      a: "string (optional)",
      b: "x",
      c: ["string"],
      d: true,
      e: "fixed",
    });
    expect(renderOutputRules(schema, { b: "pick one" })).toEqual([
      "b: exactly one of: x, y.",
      "b: pick one.",
      "d: true or false — choose the value that is actually true; the example's value is not a default.",
      'e: always exactly "fixed".',
      "Optional fields (may be omitted; never add other keys): a.",
    ]);
  });
});

describe("prompt/schema conformance — a contract-following reply parses first time", () => {
  it("global intent: the example rendered from the prompt contract satisfies the schema", () => {
    const example = exampleFromOutputShape(globalIntentOutputContract().shape);
    expect(globalRouteIntentPlanSchema.safeParse(example).success).toBe(true);
  });

  it("batch: the example rendered from the prompt contract satisfies the schema", () => {
    const { container, route_shape } = batchOutputContract();
    expect(Object.keys(container as object)).toEqual(
      Object.keys(seoContentBlueprintRoutesSchema.shape),
    );
    const example = { routes: [exampleFromOutputShape(route_shape)] };
    const result = seoContentBlueprintRoutesSchema.safeParse(example);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each([
    ["one route, one batch", true],
    ["six routes, batches of 4+2", false],
  ])("every operation validates on its first reply (%s)", async (_label, single) => {
    const routes = (single ? [1] : [1, 2, 3, 4, 5, 6]).map((n) => ({
      route_id: `r${n}`,
      path: n === 1 ? "/" : `/p${n}`,
      purpose: "content",
    }));
    const validations: Array<{ purpose: string; ok: boolean }> = [];
    const llm = {
      strategizeJson: async (args: {
        purpose: string;
        userPrompt: string;
        validate: (v: unknown) => unknown;
      }) => {
        const reply = answerBlueprintPrompt(args.userPrompt);
        try {
          const value = args.validate(reply);
          validations.push({ purpose: args.purpose, ok: true });
          return value;
        } catch (error) {
          validations.push({ purpose: args.purpose, ok: false });
          throw error;
        }
      },
    } as unknown as LlmService;
    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        first_party_authority: {
          schema: FIRST_PARTY_AUTHORITY_SCHEMA,
          market_research: "not_requested",
          domain_spec_digest: "ab".repeat(32),
          donor_count: 0,
        },
        routes,
        business_facts: [],
      },
      { llm },
    );
    expect(validations.every((v) => v.ok)).toBe(true);
    expect(validations).toHaveLength(1 + Math.ceil(routes.length / 4));
    expect(artifact.payload.routes.map((r) => r.route_id)).toEqual(routes.map((r) => r.route_id));
  });
});

describe("BATCH_INVALID stable code", () => {
  it("is exported and carried by the error", () => {
    expect(SEO_CONTENT_BLUEPRINT_BATCH_INVALID_CODE).toBe("SEO_CONTENT_BLUEPRINT_BATCH_INVALID");
    expect(new SeoContentBlueprintBatchInvalidError("x").code).toBe(
      SEO_CONTENT_BLUEPRINT_BATCH_INVALID_CODE,
    );
  });
});
