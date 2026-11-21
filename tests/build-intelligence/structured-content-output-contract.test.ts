/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The structured-content output contract is RENDERED from
 * `structuredContentRouteSchema`. These tests drive the real producer with a
 * fake model that knows nothing but the prompt it is given: no hand-written
 * fixture shape, no live calls.
 */

import {
  type ArtifactRef,
  type PageContentContractArtifact,
  type PageContentContractRoute,
  type PageContentContractV1,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  type ContentValidationVerdict,
  STRUCTURED_CONTENT_OUTPUT_CONTRACT,
  STRUCTURED_CONTENT_SECTION_KEYS,
  schemaFailureDetails,
  structuredContentRouteSchema,
} from "../../src/build-intelligence/schema-guards.js";
import { createStructuredContentPackageWithEvidence } from "../../src/build-intelligence/structured-content.js";
import type { LlmService } from "../../src/services/llm.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const dummyRef: ArtifactRef = {
  artifact_type: "website_build_blueprint",
  artifact_id: "x",
  payload_digest: "y",
};

const pass: ContentValidationVerdict = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};

/* ── QAP-shaped PageContentContract ──────────────────────────────────────────── */

const QAP_FACTS = [
  {
    fact_id: "f-name",
    key: "company_name",
    value: "Quantum AI Partners",
    verified: true as const,
    source_refs: ["spec"],
  },
  {
    fact_id: "f-model",
    key: "delivery_model",
    value: "remote-first consulting",
    verified: true as const,
    source_refs: ["spec"],
  },
];

const QAP_ROUTES: Array<{ route_id: string; path: string; sections: string[] }> = [
  {
    route_id: "home",
    path: "/",
    sections: [
      "hero",
      "problem",
      "crm_transformation",
      "process",
      "revops_activation",
      "close_deals",
      "faq",
      "final_cta",
    ],
  },
  {
    route_id: "crm-transformation",
    path: "/crm-transformation",
    sections: ["hero", "approach", "faq", "final_cta"],
  },
  { route_id: "revops", path: "/revops", sections: ["hero", "activation", "faq", "final_cta"] },
  {
    route_id: "how-it-works",
    path: "/how-it-works",
    sections: ["hero", "steps", "faq", "final_cta"],
  },
  { route_id: "contact", path: "/contact", sections: ["hero", "faq", "final_cta"] },
];

function qapRoute(spec: (typeof QAP_ROUTES)[number]): PageContentContractRoute {
  return {
    route_id: spec.route_id,
    path: spec.path,
    purpose: `QAP ${spec.route_id}`,
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: `crm consulting ${spec.route_id}`,
      supporting_queries: [],
      topics: ["crm transformation"],
      entities: ["revenue operations"],
    },
    metadata_requirements: { title: ["name the service"], description: ["<160 chars"] },
    business_facts: QAP_FACTS,
    sections: spec.sections.map((sectionId) => ({
      section_id: sectionId,
      component_class: sectionId,
      objective: `explain ${sectionId}`,
      slots: [sectionId === "faq" ? "faq" : "service_overview"],
      content_requirements: {
        requirement_ids: [`${spec.route_id}-${sectionId}`],
        topics: ["crm transformation"],
        entities: ["revenue operations"],
        questions:
          sectionId === "faq"
            ? [`How does ${spec.route_id} engagement start?`, "Is the work remote-first?"]
            : [],
      },
      allowed_fact_ids: ["f-name", "f-model"],
      proof_requirements: [],
      acceptance_tests: [],
    })),
    internal_link_requirements:
      spec.route_id === "contact" ? [] : [{ target_route_id: "contact", purpose: "convert" }],
    forbidden_claims: [],
    acceptance_tests: [],
  };
}

function qapContract(routes = QAP_ROUTES): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: routes.map(qapRoute),
  };
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "qap",
    build_id: "qap-build",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

/* ── A model that knows only the rendered contract ───────────────────────────── */

/** The JSON shape embedded in the rendered contract (between the header and "Rules:"). */
function renderedShape(contract: string): Record<string, unknown> {
  const start = contract.indexOf("{");
  const end = contract.indexOf("\nRules:");
  return JSON.parse(contract.slice(start, end)) as Record<string, unknown>;
}

/**
 * Instantiate a reply from a rendered shape as a faithful model would: every
 * non-placeholder value (structure, booleans, discriminators) is copied
 * VERBATIM, and only "string…" placeholders are written over with `prose`. It
 * never translates descriptive text into a value.
 */
function instantiate(node: unknown, write: () => string): unknown {
  if (Array.isArray(node)) return node.map((element) => instantiate(element, write));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, instantiate(child, write)]),
    );
  }
  if (typeof node === "string" && node.startsWith("string")) return write();
  return node;
}

/**
 * A writer of distinct, short, grounded phrases for one route. Every phrase is
 * under the duplicate checker's 8-word minimum and none repeats, so the fake
 * never writes duplicate copy: it covers the route's topics, entities and
 * facts across phrases, the way a compliant model varies its wording.
 */
function phraseWriter(route: PageContentContractRoute): () => string {
  const grounded = [
    String(QAP_FACTS[0]?.value),
    ...route.search_context.topics,
    ...route.search_context.entities,
    ...route.business_facts.map((fact) => String(fact.value)),
  ];
  let next = 0;
  // "Note <n>: <grounded phrase>." stays under 8 words, and <n> makes it unique.
  return () => {
    next += 1;
    return `Note ${next}: ${grounded[(next - 1) % grounded.length]}.`;
  };
}

interface RoutePrompt {
  contract_route: PageContentContractRoute;
  required_internal_link_targets: string[];
  required_section_ids: string[];
  repair_instructions?: { schema_failures: Array<{ path: string; message: string }> };
}

function parsePrompt(userPrompt: string): RoutePrompt {
  return JSON.parse(userPrompt.split("\n\n---\n")[0] ?? "{}") as RoutePrompt;
}

/**
 * Builds a route from the rendered contract alone. Prose restates the route's
 * own topics, entities and facts so the deterministic grounding checks see a
 * grounded route. `nestFaqs` reproduces the QAP canary defect.
 */
function buildFromContract(
  contract: string,
  prompt: RoutePrompt,
  options: { nestFaqs: boolean },
): Record<string, unknown> {
  const route = prompt.contract_route;
  const write = phraseWriter(route);
  const shape = renderedShape(contract);
  const base = instantiate(shape, write) as Record<string, unknown>;
  const sectionTemplate = (shape.sections as unknown[])[0];
  const faqs = route.sections.flatMap((section) =>
    section.content_requirements.questions.map((question, index) => ({
      question,
      answer: `Yes: remote-first consulting, answer ${index + 1}.`,
    })),
  );
  const sections = prompt.required_section_ids.map((sectionId) => {
    const section = instantiate(sectionTemplate, write) as Record<string, unknown>;
    section.section_id = sectionId;
    if (options.nestFaqs && sectionId === "faq") section.faqs = faqs;
    return section;
  });
  return {
    ...base,
    route_id: route.route_id,
    path: route.path,
    sections,
    faqs: options.nestFaqs ? [] : faqs,
    internal_links: prompt.required_internal_link_targets.map((target) => ({
      target_route_id: target,
      anchor_text: `Talk to ${QAP_FACTS[0]?.value}`,
    })),
  };
}

/** The canary hint the repair prompt must carry for a nested `faqs` key. */
const FAQ_PLACEMENT_HINT = "belongs ONLY at the route level (top-level key `faqs`)";

function contractFollowingModel(mode: "compliant" | "nests-faqs-until-told") {
  const log = {
    generationCalls: 0,
    firstAttemptParsed: new Map<string, boolean>(),
    systemPrompts: [] as string[],
    repairPrompts: [] as string[],
  };
  const llm = {
    async executePolicyJson(
      operation: string,
      args: {
        systemPrompt: string;
        userPrompt: string;
        validate: (value: unknown) => unknown;
        callCounter?: { value: number };
      },
    ) {
      if (args.callCounter) args.callCounter.value += 1;
      if (operation === "CONTENT_VALIDATION") return args.validate(pass);
      log.generationCalls += 1;
      log.systemPrompts.push(args.systemPrompt);
      const prompt = parsePrompt(args.userPrompt);
      const failures = prompt.repair_instructions?.schema_failures ?? [];
      if (prompt.repair_instructions) log.repairPrompts.push(args.userPrompt);
      // The model reads only the system prompt's rendered contract and, on a
      // repair, the placement hint. Without the hint it repeats its mistake.
      const told = failures.some((failure) => failure.message.includes(FAQ_PLACEMENT_HINT));
      const nestFaqs = mode === "nests-faqs-until-told" && !told;
      const value = buildFromContract(args.systemPrompt, prompt, { nestFaqs });
      const routeId = prompt.contract_route.route_id;
      const firstAttempt = !log.firstAttemptParsed.has(routeId);
      try {
        const parsed = args.validate(value);
        if (firstAttempt) log.firstAttemptParsed.set(routeId, true);
        return parsed;
      } catch (error) {
        if (firstAttempt) log.firstAttemptParsed.set(routeId, false);
        throw error;
      }
    },
  } as unknown as LlmService;
  return { llm, log };
}

/* ── Tests ───────────────────────────────────────────────────────────────────── */

describe("structured-content output contract — rendered from the schema", () => {
  it("states FAQ placement and the allowed section keys explicitly", () => {
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
      "FAQ question/answer pairs belong ONLY in the route-level `faqs` array, never inside a section.",
    );
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
      "keys: blocks (intro prose, or []), plus optional eyebrow, heading, subheading, cta.",
    );
    expect(STRUCTURED_CONTENT_SECTION_KEYS).toEqual(
      Object.keys(structuredContentRouteSchema.shape.sections.element.shape),
    );
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
      "FORBIDDEN field aliases: content, body, copy, html, paragraphs",
    );
    expect(STRUCTURED_CONTENT_OUTPUT_CONTRACT).toContain(
      "sections[].blocks is REQUIRED on EVERY section",
    );
  });

  it("renders a shape whose section carries exactly the schema's section keys and no faqs", () => {
    const shape = renderedShape(STRUCTURED_CONTENT_OUTPUT_CONTRACT);
    const section = (shape.sections as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(section)).toEqual([...STRUCTURED_CONTENT_SECTION_KEYS]);
    expect(section).not.toHaveProperty("faqs");
    expect(Object.keys(shape)).toEqual(Object.keys(structuredContentRouteSchema.shape));
  });

  it("conformance: a model following only the rendered contract builds an FAQ route that parses first time", async () => {
    const { llm, log } = contractFollowingModel("compliant");
    const { artifact } = await createStructuredContentPackageWithEvidence(
      {
        client_id: "qap",
        build_id: "qap-build",
        page_content_contract: qapContract([QAP_ROUTES[0] as (typeof QAP_ROUTES)[number]]),
      },
      { llm },
    );
    expect(log.firstAttemptParsed.get("home")).toBe(true);
    expect(log.generationCalls).toBe(1);
    const home = artifact.payload.routes[0];
    expect(home?.sections.map((section) => section.section_id)).toContain("faq");
    expect(home?.faqs.length).toBeGreaterThan(0);
    expect(log.systemPrompts[0]).toContain(STRUCTURED_CONTENT_OUTPUT_CONTRACT);
  });
});

describe("structured-content repair — unrecognized keys name where they belong", () => {
  it("adds a schema-derived placement hint for a nested faqs key", () => {
    const parsed = structuredContentRouteSchema.safeParse({
      route_id: "home",
      path: "/",
      metadata: { title: "t", description: "d" },
      sections: [{ section_id: "faq", blocks: [], faqs: [{ question: "q", answer: "a" }] }],
      faqs: [],
      internal_links: [],
      schema_content_inputs: {},
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const [failure] = schemaFailureDetails(parsed.error, structuredContentRouteSchema);
    expect(failure?.path).toBe("sections.0");
    expect(failure?.message).toContain("Unrecognized key(s) in object: 'faqs'");
    expect(failure?.message).toContain(FAQ_PLACEMENT_HINT);
  });

  it("gives no placement hint for a key the schema has nowhere", () => {
    const parsed = structuredContentRouteSchema.safeParse({
      route_id: "home",
      path: "/",
      metadata: { title: "t", description: "d" },
      sections: [{ section_id: "hero", blocks: [], content: "x" }],
      faqs: [],
      internal_links: [],
      schema_content_inputs: {},
    });
    if (parsed.success) throw new Error("expected failure");
    const [failure] = schemaFailureDetails(parsed.error, structuredContentRouteSchema);
    expect(failure?.message).toBe("Unrecognized key(s) in object: 'content'");
  });

  it("regression (QAP canary): a model that nests faqs in the faq section is corrected by the one repair", async () => {
    const { llm, log } = contractFollowingModel("nests-faqs-until-told");
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      {
        client_id: "qap",
        build_id: "qap-build",
        page_content_contract: qapContract([QAP_ROUTES[0] as (typeof QAP_ROUTES)[number]]),
      },
      { llm },
    );
    expect(log.firstAttemptParsed.get("home")).toBe(false);
    // One bounded repair, never a second.
    expect(log.generationCalls).toBe(2);
    expect(log.repairPrompts).toHaveLength(1);
    expect(log.repairPrompts[0]).toContain(FAQ_PLACEMENT_HINT);
    expect(evidence.route_results[0]).toMatchObject({ generation_calls: 2, repair_attempts: 1 });
    const home = artifact.payload.routes[0];
    expect(home?.faqs.length).toBeGreaterThan(0);
    for (const section of home?.sections ?? []) expect(section).not.toHaveProperty("faqs");
  });
});

describe("structured-content — deterministic 5-route QAP package", () => {
  it("seals all five QAP routes with their FAQ sections, each parsing on its first attempt", async () => {
    const { llm, log } = contractFollowingModel("compliant");
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-build", page_content_contract: qapContract() },
      { llm },
    );
    const routes = artifact.payload.routes;
    expect(routes.map((route) => route.path)).toEqual([
      "/",
      "/crm-transformation",
      "/revops",
      "/how-it-works",
      "/contact",
    ]);
    for (const [index, route] of routes.entries()) {
      const spec = QAP_ROUTES[index];
      expect(route.sections.map((section) => section.section_id)).toEqual(spec?.sections);
      expect(route.sections.find((section) => section.section_id === "faq")).toBeDefined();
      expect(route.faqs).toHaveLength(2);
      for (const section of route.sections) expect(section).not.toHaveProperty("faqs");
      expect(log.firstAttemptParsed.get(route.route_id)).toBe(true);
    }
    expect(log.generationCalls).toBe(5);
    expect(evidence.route_results.every((result) => result.repair_attempts === 0)).toBe(true);
  });
});
