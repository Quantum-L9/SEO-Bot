/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * StructuredContentPackage exact block-schema contract: generation must agree
 * with the Zod block union, aliases are prohibited, StructuredContent owns the
 * ONLY repair (schemaRepairAttempts: 0), repairs carry real failure evidence,
 * and the per-route budget holds: generation calls ≤ 2, repairs ≤ 1.
 */

import {
  type PageContentContractArtifact,
  type PageContentContractV1,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  createStructuredContentPackageWithEvidence,
  STRUCTURED_CONTENT_OUTPUT_CONTRACT,
} from "../../src/build-intelligence/structured-content.js";
import type { ContentValidationVerdict } from "../../src/build-intelligence/schema-guards.js";
import type { LlmService } from "../../src/services/llm.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const dummyRef = {
  artifact_type: "website_build_blueprint",
  artifact_id: "x",
  payload_digest: "y",
} as const;

function makeContract(): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: [
      {
        route_id: "home",
        path: "/",
        purpose: "primary landing",
        search_context: {
          primary_intent: "hire",
          secondary_intents: [],
          primary_query: "metal roofing",
          supporting_queries: [],
          topics: ["durability"],
          entities: ["metal roof"],
        },
        metadata_requirements: { title: ["include city"], description: ["<160 chars"] },
        business_facts: [
          {
            fact_id: "f1",
            key: "warranty",
            value: "25 year manufacturer warranty",
            verified: true,
            source_refs: ["crm:1"],
          },
        ],
        sections: [
          {
            section_id: "hero",
            component_class: "hero",
            objective: "convey primary offer",
            slots: ["primary_offer"],
            content_requirements: {
              requirement_ids: ["r1"],
              topics: ["durability"],
              entities: ["metal roof"],
              questions: ["how long?"],
            },
            allowed_fact_ids: [],
            proof_requirements: ["warranty"],
            acceptance_tests: ["mentions warranty"],
          },
        ],
        internal_link_requirements: [],
        forbidden_claims: ["lifetime free"],
        acceptance_tests: ["metadata present"],
      },
    ],
  };
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "client-1",
    build_id: "build-1",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

/**
 * Grounded reference prose exercising ALL four block shapes. Every factual
 * assertion traces to the contract's VerifiedBusinessFacts (warranty,
 * service area) so semantic validation passes.
 */
function genRoute(): StructuredContentRoute {
  return {
    route_id: "home",
    path: "/",
    metadata: {
      title: "Metal Roofing in Austin, Texas",
      description: "Durable metal roof systems for Austin, Texas homes.",
    },
    sections: [
      {
        section_id: "hero",
        heading: "Metal Roofing",
        blocks: [
          {
            kind: "paragraph",
            text:
              "A metal roof is the most durable covering available for an Austin, Texas home, " +
              "and every system we install carries a 25 year manufacturer warranty. Durability " +
              "is what the material is chosen for, so we size and fasten it for the local climate.",
          },
          {
            kind: "bullets",
            items: ["25 year manufacturer warranty", "Serving Austin, Texas"],
          },
          {
            kind: "steps",
            items: ["Call us", "We inspect your roof", "We install the metal roof"],
          },
          {
            kind: "quote",
            text: "Every system we install carries a 25 year manufacturer warranty.",
            attribution: "Installer",
          },
        ],
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
}

function withBlocks(
  route: StructuredContentRoute,
  blocks: unknown[],
): StructuredContentRoute {
  const next = structuredClone(route);
  (next.sections[0] as unknown as { blocks: unknown }).blocks = blocks;
  return next;
}

const pass: ContentValidationVerdict = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};
const fail: ContentValidationVerdict = {
  seo_blueprint_passed: false,
  contract_passed: false,
  unsupported_claims: ["unbacked pricing claim"],
  failed_requirements: ["home: unsupported claim"],
};

interface Harness {
  llm: LlmService;
  counts: { gen: number; val: number };
  prompts: string[];
  genArgs: Array<{ schemaRepairAttempts?: number }>;
}

function queueLlm(
  generations: Array<StructuredContentRoute | Error>,
  verdicts: ContentValidationVerdict[],
): Harness {
  const counts = { gen: 0, val: 0 };
  const prompts: string[] = [];
  const genArgs: Array<{ schemaRepairAttempts?: number }> = [];
  let genIndex = 0;
  const llm = {
    async executePolicyJson(
      operation: string,
      args: {
        userPrompt: string;
        validate: (v: unknown) => unknown;
        schemaRepairAttempts?: number;
      },
    ) {
      if (operation === "STRUCTURED_CONTENT_GENERATION") {
        prompts.push(args.userPrompt);
        genArgs.push(args);
        counts.gen += 1;
        const item = generations[Math.min(genIndex, generations.length - 1)];
        genIndex += 1;
        if (item instanceof Error) {
          throw item;
        }
        // schemaRepairAttempts: 0 → the caller owns the repair; a single
        // validate call mirrors executePolicyJson's no-repair path.
        return args.validate(item);
      }
      if (operation === "CONTENT_VALIDATION") {
        const v = verdicts[Math.min(counts.val, verdicts.length - 1)];
        counts.val += 1;
        return args.validate(v);
      }
      throw new Error(`unexpected op ${operation}`);
    },
  } as unknown as LlmService;
  return { llm, counts, prompts, genArgs };
}

async function build(harness: Harness) {
  return createStructuredContentPackageWithEvidence(
    { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
    { llm: harness.llm },
  );
}

describe("StructuredContentPackage — exact block schema generation", () => {
  it("accepts the exact block union (paragraph/bullets/steps/quote)", async () => {
    const harness = queueLlm([genRoute()], [pass]);
    const { artifact, evidence } = await build(harness);
    expect(artifact.payload.routes[0]!.sections[0]!.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "bullets",
      "steps",
      "quote",
    ]);
    expect(evidence.repair_attempts).toBe(0);
    expect(evidence.generation_calls).toBe(1);
  });

  it("prompts teach the exact contract and pass schemaRepairAttempts: 0", async () => {
    const harness = queueLlm([genRoute()], [pass]);
    await build(harness);
    expect(harness.prompts[0]).toContain("blocks");
    expect(harness.prompts[0]).toContain("output_contract");
    expect(harness.genArgs[0]!.schemaRepairAttempts).toBe(0);
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT.sections).toBeTruthy();
  });

  it("prohibits the content alias: repair once with SCHEMA_FAILURE evidence", async () => {
    const aliasRoute = withBlocks(genRoute(), []);
    (aliasRoute.sections[0] as unknown as { content?: string }).content = "plain text";
    const harness = queueLlm([aliasRoute, genRoute()], [pass]);
    const { evidence } = await build(harness);
    expect(evidence.repair_attempts).toBe(1);
    expect(evidence.generation_calls).toBe(2);
    expect(harness.prompts[1]).toContain("SCHEMA_FAILURE");
    expect(harness.prompts[1]).toContain("repair_instructions");
  });

  it.each([
    ["missing blocks", (r: StructuredContentRoute) => withBlocks(r, [])],
    ["blocks as string", (r: StructuredContentRoute) => withBlocks(r, ["not a block"])],
    [
      "unknown block kind",
      (r: StructuredContentRoute) =>
        withBlocks(r, [{ kind: "carousel", items: ["x"] } as unknown]),
    ],
    [
      "paragraph without text",
      (r: StructuredContentRoute) => withBlocks(r, [{ kind: "paragraph" } as unknown]),
    ],
    [
      "bullets without items",
      (r: StructuredContentRoute) => withBlocks(r, [{ kind: "bullets" } as unknown]),
    ],
    [
      "steps without items",
      (r: StructuredContentRoute) => withBlocks(r, [{ kind: "steps" } as unknown]),
    ],
    [
      "quote without text",
      (r: StructuredContentRoute) =>
        withBlocks(r, [{ kind: "quote", attribution: "someone" } as unknown]),
    ],
  ])("repairs once when %s, terminal when the repair also fails", async (_name, mutate) => {
    const bad = mutate(genRoute());
    const harness = queueLlm([bad, genRoute()], [pass]);
    const { evidence } = await build(harness);
    expect(evidence.repair_attempts).toBe(1);
    expect(evidence.generation_calls).toBe(2);

    const terminal = queueLlm([bad, bad], [pass]);
    await expect(build(terminal)).rejects.toThrow();
    expect(terminal.counts.gen).toBe(2); // exactly one repair, then terminal
  });

  it("missing required section → repair once → success", async () => {
    const missing = genRoute();
    (missing.sections as unknown) = [];
    const harness = queueLlm([missing, genRoute()], [pass]);
    const { evidence } = await build(harness);
    expect(evidence.repair_attempts).toBe(1);
    expect(harness.prompts[1]).toContain("SCHEMA_FAILURE");
  });

  it("extra section → repair once → success", async () => {
    const extra = genRoute();
    (extra.sections as StructuredContentRoute["sections"]).push({
      section_id: "ghost",
      blocks: [{ kind: "paragraph", text: "extra" }],
    });
    const harness = queueLlm([extra, genRoute()], [pass]);
    const { evidence } = await build(harness);
    expect(evidence.repair_attempts).toBe(1);
  });

  it("duplicate section → terminal after the single repair", async () => {
    const dup = genRoute();
    (dup.sections as StructuredContentRoute["sections"]).push(
      structuredClone(dup.sections[0]!),
    );
    const harness = queueLlm([dup, dup], [pass]);
    await expect(build(harness)).rejects.toThrow(/Duplicate section_id/);
    expect(harness.counts.gen).toBe(2);
  });

  it("re-asserts route identity (model cannot change route_id or path)", async () => {
    const tampered = genRoute();
    (tampered as { route_id: string; path: string }).route_id = "ghost";
    (tampered as { route_id: string; path: string }).path = "/WRONG";
    const harness = queueLlm([tampered], [pass]);
    const { artifact } = await build(harness);
    expect(artifact.payload.routes[0]!.route_id).toBe("home");
    expect(artifact.payload.routes[0]!.path).toBe("/");
  });

  it("semantic fail → one content repair with CONTENT_VALIDATION_FAILURE evidence", async () => {
    const harness = queueLlm([genRoute(), genRoute()], [fail, pass]);
    const { evidence } = await build(harness);
    expect(evidence.repair_attempts).toBe(1);
    expect(evidence.generation_calls).toBe(2);
    expect(harness.prompts[1]).toContain("CONTENT_VALIDATION_FAILURE");
    expect(harness.prompts[1]).toContain("unbacked pricing claim");
  });

  it("semantic fail → repair fails → terminal with the failure dimensions", async () => {
    const harness = queueLlm([genRoute(), genRoute()], [fail, fail]);
    await expect(build(harness)).rejects.toMatchObject({
      code: "CONTENT_REQUIREMENT_UNSATISFIED",
    });
    expect(harness.counts.gen).toBe(2);
  });

  it("budget holds: at most 2 generation calls and 1 repair per route", async () => {
    const harness = queueLlm([genRoute(), genRoute()], [fail, pass]);
    const { evidence } = await build(harness);
    expect(evidence.generation_calls).toBeLessThanOrEqual(2);
    expect(evidence.repair_attempts).toBeLessThanOrEqual(1);
  });
});
