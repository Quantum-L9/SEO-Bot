/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import {
  type ArtifactRef,
  type PageContentContractArtifact,
  type PageContentContractV1,
  refForArtifact,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  type ContentValidationVerdict,
  structuredContentRouteSchema,
} from "../../src/build-intelligence/schema-guards.js";
import {
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackage,
  createStructuredContentPackageWithEvidence,
} from "../../src/build-intelligence/structured-content.js";
import type { LlmService } from "../../src/services/llm.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const dummyRef: ArtifactRef = {
  artifact_type: "website_build_blueprint",
  artifact_id: "x",
  payload_digest: "y",
};

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
          {
            fact_id: "f2",
            key: "service_area",
            value: "Austin, Texas",
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
 * Grounded reference prose: every factual assertion (the warranty, the 25-year
 * term, the service area) traces to a VerifiedBusinessFact on the contract.
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
        ],
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
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

function fakeLlm(verdicts: ContentValidationVerdict[]): {
  llm: LlmService;
  counts: { gen: number; val: number };
} {
  const counts = { gen: 0, val: 0 };
  const llm = {
    async executePolicyJson(
      operation: string,
      args: { validate: (v: unknown) => unknown; callCounter?: { value: number } },
    ) {
      // Mirror the real service: one counter increment per ACTUAL LLM call.
      // Generation runs with schemaRepairAttempts=0, so one invocation = one
      // call; the semantic verdicts here always parse, so one invocation = one
      // call there too.
      if (args.callCounter) args.callCounter.value += 1;
      if (operation === "STRUCTURED_CONTENT_GENERATION") {
        counts.gen += 1;
        return args.validate(genRoute());
      }
      if (operation === "CONTENT_VALIDATION") {
        const v = verdicts[Math.min(counts.val, verdicts.length - 1)];
        counts.val += 1;
        return args.validate(v);
      }
      throw new Error(`unexpected op ${operation}`);
    },
  } as unknown as LlmService;
  return { llm, counts };
}

describe("StructuredContentPackage — lineage, identity, bounded repair", () => {
  it("rejects a tampered PageContentContract BEFORE any LLM spend", async () => {
    const contract = makeContract();
    // Tamper the sealed payload so its digest no longer matches integrity.
    (contract.payload.routes[0] as { path: string }).path = "/tampered";
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
        { llm },
      ),
    ).rejects.toThrow(/INTEL_ARTIFACT_HASH_MISMATCH/);
    expect(counts.gen).toBe(0);
    expect(counts.val).toBe(0);
  });

  it("preserves route IDs and section IDs from the contract exactly", async () => {
    const { llm } = fakeLlm([pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(pkg.payload.routes.map((r) => r.route_id)).toEqual(["home"]);
    expect(pkg.payload.routes[0]!.sections.map((s) => s.section_id)).toEqual(["hero"]);
  });

  it("references the EXACT PageContentContract artifact", async () => {
    const contract = makeContract();
    const { llm } = fakeLlm([pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
      { llm },
    );
    expect(pkg.payload.page_content_contract_ref).toEqual(refForArtifact(contract));
    expect(pkg.input_refs).toEqual([refForArtifact(contract)]);
  });

  it("fires exactly ONE bounded repair when a route first fails, then seals on success", async () => {
    const { llm, counts } = fakeLlm([fail, pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(counts.gen).toBe(2); // initial + one repair
    expect(counts.val).toBe(2); // validate after each generation
    expect(pkg.payload.validation.contract_passed).toBe(true);
    expect(pkg.payload.validation.unsupported_claims).toEqual([]);
  });

  it("is terminal (CONTENT_REQUIREMENT_UNSATISFIED) when the route still fails after repair", async () => {
    const { llm, counts } = fakeLlm([fail, fail]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect(counts.gen).toBe(2); // no unbounded retry beyond the single repair
  });

  it("MEASURES the repair count rather than inferring it from the sealed block", async () => {
    const clean = fakeLlm([pass]);
    const noRepair = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm: clean.llm },
    );
    expect(noRepair.evidence.repair_attempts).toBe(0);
    expect(noRepair.evidence.generation_llm_calls).toBe(1);
    expect(noRepair.evidence.semantic_validation_llm_calls).toBe(1);
    expect(noRepair.evidence.schema_failure_count).toBe(0);

    const repaired = fakeLlm([fail, pass]);
    const withRepair = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm: repaired.llm },
    );
    expect(withRepair.evidence.repair_attempts).toBe(1);
    expect(withRepair.evidence.repaired_route_ids).toEqual(["home"]);
    expect(withRepair.evidence.generation_llm_calls).toBe(2);
    expect(withRepair.evidence.semantic_validation_llm_calls).toBe(2);
    expect(withRepair.evidence.schema_failure_count).toBe(0);
    // Both packages seal with an identical clean validation block — which is
    // exactly why the count cannot be read back out of it.
    expect(withRepair.artifact.payload.validation).toEqual(noRepair.artifact.payload.validation);
  });

  it("scopes the repair to the failed dimensions only", async () => {
    const prompts: string[] = [];
    const llm = {
      async executePolicyJson(
        operation: string,
        args: { userPrompt: string; validate: (v: unknown) => unknown },
      ) {
        if (operation === "STRUCTURED_CONTENT_GENERATION") {
          prompts.push(args.userPrompt);
          return args.validate(genRoute());
        }
        return args.validate(prompts.length === 1 ? fail : pass);
      },
    } as unknown as LlmService;

    await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("repair_instructions");
    expect(prompts[1]).toContain("repair_instructions");
    expect(prompts[1]).toContain("unbacked pricing claim");
    // The repair prompt always carries the schema-failure slot (empty here) so
    // the evidence shape is stable across schema- and semantic-failure repairs.
    expect(prompts[1]).toContain("schema_failures");
  });
});

describe("StructuredContentPackage — the exact contract is the only authority", () => {
  it("rejects a contract belonging to a different client", async () => {
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        { client_id: "other-client", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
    expect(counts.gen).toBe(0);
  });

  it("rejects a STALE contract from a different build", async () => {
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-2", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
    expect(counts.gen).toBe(0);
  });

  it("rejects an artifact that is not a page_content_contract", async () => {
    const contract = makeContract();
    const foreign = sealIntelligenceArtifact({
      artifact_type: "seo_content_blueprint",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "SEO-Bot", version: "1.0.0" },
      payload: contract.payload,
    });
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        {
          client_id: "client-1",
          build_id: "build-1",
          page_content_contract: foreign as unknown as PageContentContractArtifact,
        },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
    expect(counts.gen).toBe(0);
  });

  it("rejects a contract that declares no routes", async () => {
    const payload = structuredClone(makeContract().payload);
    payload.routes = [];
    const empty = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: empty },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
    expect(counts.gen).toBe(0);
  });

  it("rejects a contract with duplicate route ids", async () => {
    const payload = structuredClone(makeContract().payload);
    payload.routes = [payload.routes[0]!, structuredClone(payload.routes[0]!)];
    const dup = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const { llm } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: dup },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
  });

  it("produces a route set that matches the contract one-for-one, in order", async () => {
    const payload = structuredClone(makeContract().payload);
    const second = structuredClone(payload.routes[0]!);
    second.route_id = "services";
    second.path = "/services";
    payload.routes = [payload.routes[0]!, second];
    const contract = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const llm = {
      async executePolicyJson(operation: string, args: { validate: (v: unknown) => unknown }) {
        if (operation === "STRUCTURED_CONTENT_GENERATION") return args.validate(genRoute());
        return args.validate(pass);
      },
    } as unknown as LlmService;

    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
      { llm },
    );
    expect(pkg.payload.routes.map((r) => r.route_id)).toEqual(["home", "services"]);
    expect(pkg.payload.routes.map((r) => r.path)).toEqual(["/", "/services"]);
  });

  it("rejects an accompanying blueprint from a different build", async () => {
    const blueprint = sealIntelligenceArtifact({
      artifact_type: "seo_content_blueprint",
      client_id: "client-1",
      build_id: "build-999",
      producer: { repo: "SEO-Bot", version: "1.0.0" },
      payload: {
        schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
        competitive_landscape_ref: {
          ...dummyRef,
          artifact_type: "competitive_landscape" as const,
        },
        routes: [],
      },
    });
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage(
        {
          client_id: "client-1",
          build_id: "build-1",
          page_content_contract: makeContract(),
          seo_content_blueprint: blueprint,
        },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "PAGE_CONTENT_CONTRACT_INVALID" });
    expect(counts.gen).toBe(0);
  });

  it("refuses to seal a package whose validation block records failures", async () => {
    // A verdict that claims to pass while still carrying an unsupported claim
    // must never reach a sealed artifact.
    const contradictory: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: true,
      unsupported_claims: [],
      failed_requirements: [],
    };
    const { llm } = fakeLlm([contradictory]);
    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(pkg.payload.validation).toEqual({
      seo_blueprint_passed: true,
      contract_passed: true,
      unsupported_claims: [],
      failed_requirements: [],
    });
  });

  it("catches an unsupported factual claim deterministically, before the semantic pass", async () => {
    let semanticCalls = 0;
    const llm = {
      async executePolicyJson(operation: string, args: { validate: (v: unknown) => unknown }) {
        if (operation === "STRUCTURED_CONTENT_GENERATION") {
          const bad = genRoute();
          bad.sections[0]!.blocks = [
            {
              kind: "paragraph",
              text:
                "With decades of experience roofing Austin, Texas homes, our crews install " +
                "durable metal roof systems backed by a 25 year manufacturer warranty.",
            },
          ];
          return args.validate(bad);
        }
        semanticCalls += 1;
        return args.validate(pass);
      },
    } as unknown as LlmService;

    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_REQUIREMENT_UNSATISFIED" });
    // Deterministic failure short-circuits the semantic pass entirely.
    expect(semanticCalls).toBe(0);
  });
});

/* ── Schema-contract regression suite (blocks union, forbidden aliases) ────── */

describe("StructuredContentPackage — blocks-union output contract (schema regression)", () => {
  it("rejects a section that uses the forbidden `content` alias instead of blocks", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0] = { section_id: "hero", content: "prose smuggled outside blocks" };
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects a section with no blocks at all", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0] = { section_id: "hero", heading: "h" };
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects `blocks` supplied as a string instead of an array", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = "a paragraph of prose";
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects an unknown block kind", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = [{ kind: "rich_text", html: "<p>x</p>" }];
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects a paragraph block without text", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = [{ kind: "paragraph" }];
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects a bullets block without items", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = [{ kind: "bullets" }];
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects a quote block without text", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = [{ kind: "quote", attribution: "anon" }];
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("rejects malformed metadata (missing description)", () => {
    const route: any = structuredClone(genRoute());
    route.metadata = { title: "t" };
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(false);
  });

  it("accepts every block variant of the taught union", () => {
    const route: any = structuredClone(genRoute());
    route.sections[0].blocks = [
      { kind: "paragraph", text: "p" },
      { kind: "bullets", items: ["a", "b"] },
      { kind: "steps", items: ["1", "2"] },
      { kind: "quote", text: "q", attribution: "owner" },
    ];
    expect(structuredContentRouteSchema.safeParse(route).success).toBe(true);
  });

  it("teaches the blocks union and the forbidden aliases in the generation system prompt", async () => {
    const systemPrompts: string[] = [];
    const llm = {
      async executePolicyJson(operation: string, args: { systemPrompt: string; validate: (v: unknown) => unknown }) {
        if (operation === "STRUCTURED_CONTENT_GENERATION") {
          systemPrompts.push(args.systemPrompt);
          return args.validate(genRoute());
        }
        return args.validate(pass);
      },
    } as unknown as LlmService;

    await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).toContain('kind: "paragraph"');
    expect(systemPrompts[0]).toContain('kind: "bullets"');
    expect(systemPrompts[0]).toContain('kind: "steps"');
    expect(systemPrompts[0]).toContain('kind: "quote"');
    expect(systemPrompts[0]).toContain(
      "FORBIDDEN field aliases: content, body, copy, html, paragraphs",
    );
  });
});

/* ── One-repair budget: generation ≤ 2 calls per route, no hidden nested repair ─ */

describe("StructuredContentPackage — one repair budget (schema + semantic)", () => {
  /** Generations return the given values in order; validations return the given verdicts. */
  function fakeGenerations(
    genValues: unknown[],
    verdicts: ContentValidationVerdict[],
  ): { llm: LlmService; prompts: string[] } {
    const prompts: string[] = [];
    let genIdx = 0;
    let valIdx = 0;
    const llm = {
      async executePolicyJson(
        operation: string,
        args: {
          userPrompt: string;
          systemPrompt?: string;
          validate: (v: unknown) => unknown;
          callCounter?: { value: number };
        },
      ) {
        if (args.callCounter) args.callCounter.value += 1;
        if (operation === "STRUCTURED_CONTENT_GENERATION") {
          prompts.push(args.userPrompt);
          const value = genValues[Math.min(genIdx, genValues.length - 1)];
          genIdx += 1;
          return args.validate(value);
        }
        if (operation === "CONTENT_VALIDATION") {
          const verdict = verdicts[Math.min(valIdx, verdicts.length - 1)];
          valIdx += 1;
          return args.validate(verdict);
        }
        throw new Error(`unexpected op ${operation}`);
      },
    } as unknown as LlmService;
    return { llm, prompts };
  }

  const routeWithContentAlias: unknown = (() => {
    const route: any = structuredClone(genRoute());
    route.sections[0] = { section_id: "hero", content: "alias prose" };
    return route;
  })();

  it("first generation schema-invalid → one repair with schema_failures evidence → seals", async () => {
    const { llm, prompts } = fakeGenerations([routeWithContentAlias, genRoute()], [pass]);
    const { evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(evidence.generation_llm_calls).toBe(2);
    expect(evidence.semantic_validation_llm_calls).toBe(1); // only after the repair parses
    expect(evidence.repair_attempts).toBe(1);
    expect(evidence.schema_failure_count).toBe(1);
    expect(evidence.repaired_route_ids).toEqual(["home"]);
    // The repair prompt carries the exact schema failure evidence and the
    // exact output contract again.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("schema_failures");
    expect(prompts[1]).toContain("The exact output contract again");
    expect(prompts[1]).toContain("FORBIDDEN field aliases");
  });

  it("is terminal when the repair output is still schema-invalid", async () => {
    const { llm } = fakeGenerations([routeWithContentAlias, routeWithContentAlias], [pass]);
    await expect(
      createStructuredContentPackageWithEvidence(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
  });

  it("never issues a hidden nested repair: schema-fail then semantic-fail stays within two generation calls", async () => {
    const { llm, prompts } = fakeGenerations([routeWithContentAlias, genRoute()], [fail]);
    await expect(
      createStructuredContentPackageWithEvidence(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_REQUIREMENT_UNSATISFIED" });
    // The route consumed its one repair on the schema failure; the semantic
    // failure is terminal. Under the old nested-repair bug this would have
    // made up to four generation calls.
    expect(prompts).toHaveLength(2);
  });

  it("reports repair_attempts ≤ route_count and at most one per route across two routes", async () => {
    const payload = structuredClone(makeContract().payload);
    const second = structuredClone(payload.routes[0]!);
    second.route_id = "services";
    second.path = "/services";
    payload.routes = [payload.routes[0]!, second];
    const contract = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const { llm } = fakeLlm([fail, pass, fail, pass]);
    const { evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
      { llm },
    );
    expect(evidence.route_count).toBe(2);
    expect(evidence.repair_attempts).toBe(2);
    expect(evidence.repair_attempts).toBeLessThanOrEqual(evidence.route_count);
    expect(evidence.repaired_route_ids).toEqual(["home", "services"]);
    expect(evidence.generation_llm_calls).toBe(4); // exactly two per route
  });
});
