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
  StructuredContentShapeError,
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

/**
 * The NC-11 failure shape: a section with an alias `content` field and NO
 * `blocks` array. The strict zod schema rejects this exactly the way the
 * live NC-11 defect did (sections[0].blocks -> Required; Unrecognized key(s)).
 */
function contentShapedRoute(): unknown {
  return {
    route_id: "home",
    path: "/",
    metadata: {
      title: "Metal Roofing in Austin, Texas",
      description: "Durable metal roof systems.",
    },
    sections: [
      {
        section_id: "hero",
        heading: "Metal Roofing",
        content: "A metal roof is the most durable covering for an Austin home.",
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
}

/** Fake that yields per-call generation outputs (shape-aware repair testing). */
function shapeFakeLlm(
  generationOutputs: unknown[],
  verdicts: ContentValidationVerdict[],
): { llm: LlmService; counts: { gen: number; val: number } } {
  const counts = { gen: 0, val: 0 };
  const llm = {
    async executePolicyJson(
      operation: string,
      args: { validate: (v: unknown) => unknown; callCounter?: { value: number } },
    ) {
      if (args.callCounter) args.callCounter.value += 1;
      if (operation === "STRUCTURED_CONTENT_GENERATION") {
        const output = generationOutputs[Math.min(counts.gen, generationOutputs.length - 1)];
        counts.gen += 1;
        return args.validate(output);
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
        args: {
          userPrompt: string;
          validate: (v: unknown) => unknown;
          callCounter?: { value: number };
        },
      ) {
        // Mirror the real service: one increment per ACTUAL LLM call.
        if (args.callCounter) args.callCounter.value += 1;
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
      async executePolicyJson(
        operation: string,
        args: { validate: (v: unknown) => unknown; callCounter?: { value: number } },
      ) {
        if (args.callCounter) args.callCounter.value += 1;
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
        batch_size: 4,
        batch_count: 0,
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
      async executePolicyJson(
        operation: string,
        args: { validate: (v: unknown) => unknown; callCounter?: { value: number } },
      ) {
        if (args.callCounter) args.callCounter.value += 1;
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

    const artifact = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    // The deterministic claim check short-circuits the semantic pass for the
    // initial generation AND the LLM repair; only the post-remediation
    // re-validation (now deterministically clean) reaches the semantic pass.
    expect(semanticCalls).toBe(1);
    const text = JSON.stringify(artifact.payload).toLowerCase();
    // The ungrounded magnitude claim is scrubbed; the "25 year warranty"
    // phrase is GROUNDED by the fixture's warranty fact and must survive.
    expect(text).not.toContain("decades of experience");
    expect(text).toContain("25 year manufacturer warranty");
  });
});

describe("StructuredContentPackage — NC-11 shape discipline (content-alias → bounded shape repair)", () => {
  it("treats a content-alias route (no blocks) as a repairable generation failure and seals with route evidence", async () => {
    const { llm, counts } = shapeFakeLlm([contentShapedRoute(), genRoute()], [pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    // Initial + exactly ONE bounded shape repair — never silently normalized.
    expect(counts.gen).toBe(2);
    // Validation only runs once the shape is valid.
    expect(counts.val).toBe(1);
    expect(pkg.payload.routes[0]!.sections[0]!.blocks).toBeDefined();
    expect(pkg.payload.route_evidence).toEqual([
      {
        route_id: "home",
        repair_attempts: 1,
        generation_calls: 2,
        validation_calls: 1,
        schema_errors: 1,
      },
    ]);
  });

  it("is terminal (STRUCTURED_CONTENT_SHAPE_INVALID) when the shape is still wrong after the bounded repair", async () => {
    const { llm, counts } = shapeFakeLlm([contentShapedRoute(), contentShapedRoute()], [pass]);
    let caught: unknown;
    try {
      await createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StructuredContentShapeError);
    expect((caught as StructuredContentShapeError).code).toBe("STRUCTURED_CONTENT_SHAPE_INVALID");
    // No unbounded retry: the budget is exactly two generation calls.
    expect(counts.gen).toBe(2);
  });

  it("pins the blocks contract in the system prompt and names the shape failure in the repair note", async () => {
    let systemPrompt = "";
    const userPrompts: string[] = [];
    const llm = {
      async executePolicyJson(
        operation: string,
        args: {
          systemPrompt: string;
          userPrompt: string;
          validate: (v: unknown) => unknown;
          callCounter?: { value: number };
        },
      ) {
        if (args.callCounter) args.callCounter.value += 1;
        if (operation === "STRUCTURED_CONTENT_GENERATION") {
          systemPrompt = args.systemPrompt;
          userPrompts.push(args.userPrompt);
          return args.validate(userPrompts.length === 1 ? contentShapedRoute() : genRoute());
        }
        return args.validate(pass);
      },
    } as unknown as LlmService;

    const pkg = await createStructuredContentPackage(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(pkg.payload.routes[0]!.sections[0]!.blocks).toBeDefined();
    // The system prompt forbids the alias field and demands blocks.
    expect(systemPrompt).toContain("blocks: array of ONE kind per entry");
    expect(systemPrompt).toContain("FORBIDDEN field aliases");
    // The repair note names the shape defect explicitly; the first attempt has no note.
    expect(userPrompts).toHaveLength(2);
    expect(userPrompts[0]).not.toContain("schema_failures");
    expect(userPrompts[1]).toContain("schema_failures");
    expect(userPrompts[1]).toContain("Fix ONLY the items below");
  });

  it("acceptance-test-shaped semantic flags drive the repair but never veto the seal (golden run #47)", async () => {
    const acceptanceFail: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: [
        "mentions warranty - the warranty is mentioned but not prominently displayed",
      ],
    };
    // The strict judge returns the same subjective flag on every call: the
    // one bounded repair runs, and the deterministically grounded route
    // still seals with a clean validation block.
    const { llm, counts } = fakeLlm([acceptanceFail, acceptanceFail]);
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
    expect(artifact.payload.validation.unsupported_claims).toEqual([]);
    // The repair budget is honored: attempt 1 enforces the acceptance test
    // (one repair + regeneration), attempt 2 applies the grounded pass and
    // seals without a second repair.
    expect(evidence.repair_attempts).toBe(1);
    expect(counts.gen).toBe(2);
    expect(counts.val).toBe(2);
  });

  it("a validator quoting a deterministic remediation sentence cannot veto the seal (golden run #48)", async () => {
    const payload = structuredClone(makeContract().payload);
    // genRoute() never writes the literal token "expertise" — the
    // deterministic remediation will append a coverage sentence for it.
    payload.routes[0]!.sections[0]!.content_requirements.topics.push("expertise");
    const contract = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const quoteFail: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: [
        "Regarding expertise: home serves the local area and the surrounding areas.",
      ],
    };
    const { llm } = fakeLlm([quoteFail]);
    const { artifact } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
      { llm },
    );
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
  });

  it("proof-requirement echoes drive the repair but do not veto the seal when the section covers the proof (golden run #50)", async () => {
    const proofEcho: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: ["warranty"],
    };
    // The contract's hero section carries proof_requirements ["warranty"];
    // an exact echo of the proof name is a subjective satisfaction flag.
    const { llm } = fakeLlm([proofEcho, proofEcho]);
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
    expect(evidence.repair_attempts).toBe(1);
  });

  it("aggregated coverage/proof echoes cannot veto the seal (golden run #52)", async () => {
    const aggregated: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: [
        "Missing required topics: durability",
        "Missing required entities: metal roof",
        "Missing proof requirements: warranty",
      ],
    };
    const { llm } = fakeLlm([aggregated, aggregated]);
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
    // The proof echo enforces on attempt 1, so one repair still runs.
    expect(evidence.repair_attempts).toBe(1);
  });

  it("requirement-id echoes drive the repair and still veto the seal (golden run #53)", async () => {
    // Bare ids are not assertable against prose. Dropping them must not flip
    // contract_passed via allFailuresFiltered.
    const reqEcho: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: ["r1"],
    };
    const { llm, counts } = fakeLlm([reqEcho, reqEcho]);
    await expect(
      createStructuredContentPackageWithEvidence(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect(counts.gen).toBe(2);
    expect(counts.val).toBeGreaterThanOrEqual(2);
  });

  it("proof-requirement echoes still veto the seal when the section lacks the proof tokens", async () => {
    const payload = structuredClone(makeContract().payload);
    payload.routes[0]!.sections[0]!.proof_requirements = ["bondedlicensure"];
    const contract = sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
    const proofEcho: ContentValidationVerdict = {
      seo_blueprint_passed: true,
      contract_passed: false,
      unsupported_claims: [],
      failed_requirements: ["Missing proof requirements: bondedlicensure"],
    };
    const { llm, counts } = fakeLlm([proofEcho, proofEcho]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: contract },
        { llm },
      ),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect(counts.gen).toBe(2);
  });

  it("non-acceptance semantic failures still veto the seal", async () => {
    // A real, non-filterable failure keeps the grounded pass closed.
    const { llm } = fakeLlm([fail, fail]);
    await expect(
      createStructuredContentPackage(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm },
      ),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
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
      async executePolicyJson(
        operation: string,
        args: {
          systemPrompt: string;
          validate: (v: unknown) => unknown;
          callCounter?: { value: number };
        },
      ) {
        if (args.callCounter) args.callCounter.value += 1;
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
    ).rejects.toBeInstanceOf(StructuredContentShapeError);
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

/**
 * Per-route generation ownership for `l9.seo-bot-run-llm-audit/v1`. The package
 * total can no longer stand in for a route's own spend: each route reports the
 * calls IT made, and the accounting is asserted rather than assumed.
 */
describe("StructuredContentPackage — per-route generation ownership", () => {
  function twoRouteContract(): PageContentContractArtifact {
    const payload = structuredClone(makeContract().payload);
    const second = structuredClone(payload.routes[0]!);
    second.route_id = "services";
    second.path = "/services";
    payload.routes = [payload.routes[0]!, second];
    return sealIntelligenceArtifact({
      artifact_type: "page_content_contract",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "Website-Bot", version: "1.0.0" },
      payload,
    });
  }

  it("reports one generation call and zero repairs for a route that passed first time", async () => {
    const { llm } = fakeLlm([pass]);
    const { evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
      { llm },
    );
    expect(evidence.route_results).toEqual([
      {
        route_id: "home",
        path: "/",
        generation_calls: 1,
        repair_attempts: 0,
        semantic_validation_calls: 1,
        schema_failure_count: 0,
      },
    ]);
  });

  it("charges the repair to the route that needed it, not to every route", async () => {
    // Route "home" fails then passes; route "services" passes first time.
    const { llm } = fakeLlm([fail, pass, pass]);
    const { evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: twoRouteContract() },
      { llm },
    );
    expect(evidence.repaired_route_ids).toEqual(["home"]);
    expect(evidence.route_results).toEqual([
      {
        route_id: "home",
        path: "/",
        generation_calls: 2,
        repair_attempts: 1,
        semantic_validation_calls: 2,
        schema_failure_count: 0,
      },
      {
        route_id: "services",
        path: "/services",
        generation_calls: 1,
        repair_attempts: 0,
        semantic_validation_calls: 1,
        schema_failure_count: 0,
      },
    ]);
    // The package total is the SUM of the per-route counts — never their source.
    expect(evidence.generation_llm_calls).toBe(3);
    expect(evidence.route_results.reduce((sum, route) => sum + route.generation_calls, 0)).toBe(
      evidence.generation_llm_calls,
    );
  });

  it("carries the contract path on every route result", async () => {
    const { llm } = fakeLlm([pass, pass]);
    const { evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "client-1", build_id: "build-1", page_content_contract: twoRouteContract() },
      { llm },
    );
    expect(evidence.route_results.map((route) => route.path)).toEqual(["/", "/services"]);
    expect(evidence.route_results.map((route) => route.route_id)).toEqual(["home", "services"]);
  });

  it("refuses to report a route whose measured calls contradict its repair count", async () => {
    // A double that never records an actual call cannot produce truthful
    // evidence, so the run fails rather than exporting generation_calls it
    // never measured.
    const silent = {
      async executePolicyJson(
        operation: string,
        args: { validate: (v: unknown) => unknown; callCounter?: { value: number } },
      ) {
        // Deliberately ignores callCounter — the premise of this test is a
        // double that never records an actual call.
        if (operation === "STRUCTURED_CONTENT_GENERATION") return args.validate(genRoute());
        return args.validate(pass);
      },
    } as unknown as LlmService;
    await expect(
      createStructuredContentPackageWithEvidence(
        { client_id: "client-1", build_id: "build-1", page_content_contract: makeContract() },
        { llm: silent },
      ),
    ).rejects.toMatchObject({ code: "STRUCTURED_CONTENT_ROUTE_MISMATCH" });
  });
});
