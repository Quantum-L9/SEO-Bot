/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  refForArtifact,
  type SEOContentBlueprintRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  createSEOContentBlueprint,
  type PageContentPort,
} from "../../src/build-intelligence/seo-content-blueprint.js";
import type { LlmService } from "../../src/services/llm.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeLandscape(): CompetitiveLandscapeArtifact {
  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: { niche: "roofing", country: "United States", language: "English", device: "desktop" },
    query_portfolio: [{ query_id: "q1", query: "metal roofing", intent: "commercial", weight: 1 }],
    observations: [
      {
        observation_id: "q1-r1",
        query_id: "q1",
        rank: 1,
        url: "https://alpha-roofing.com/metal",
        domain: "alpha-roofing.com",
        observed_at: "2024-01-01T00:00:00.000Z",
        source: "dataforseo",
      },
    ],
    domains: [
      {
        domain: "alpha-roofing.com",
        aggregate_visibility: 1,
        qualifying_query_ids: ["q1"],
        observation_ids: ["q1-r1"],
      },
    ],
    selected_donors: [
      { domain: "alpha-roofing.com", aggregate_visibility: 1, observation_ids: ["q1-r1"] },
    ],
    exclusions: [],
    evidence_complete: true,
    ranking_llm_calls: 0,
  };
  return sealIntelligenceArtifact({
    artifact_type: "competitive_landscape",
    client_id: "client-1",
    build_id: "build-1",
    producer: { repo: "SEO-Bot", version: "2.1.0" },
    payload,
  });
}

function blueprintRoute(routeId: string, path: string): SEOContentBlueprintRoute {
  return {
    route_id: routeId,
    path,
    search_intent: { primary: "hire a metal roofer", secondary: [], journey_stage: "commercial" },
    targets: {
      primary_query: "metal roofing",
      supporting_queries: [],
      topics: ["durability"],
      entities: ["metal roof"],
    },
    requirements: [
      {
        requirement_id: "r1",
        target_slots: ["primary_offer"],
        placement: "FIRST_MATCH",
        required_topics: ["durability"],
        required_entities: ["metal roof"],
        questions: ["how long does it last?"],
        proof_needed: ["warranty"],
        required: true,
      },
    ],
    competitive_gaps: [
      {
        gap_id: "g1",
        description: "no pricing",
        donor_domains: ["alpha-roofing.com"],
        opportunity: "add pricing",
      },
    ],
    internal_links: [],
    aeo_geo: { answer_targets: [], schema_requirements: [] },
    metadata: { title_requirements: ["include city"], description_requirements: ["<160 chars"] },
    forbidden_claims: [],
    acceptance_tests: ["mentions warranty"],
  };
}

const requestedRoutes = [{ route_id: "home", path: "/", purpose: "primary landing" }];

function fakeLlm(modelRoutes: SEOContentBlueprintRoute[]): {
  llm: LlmService;
  calls: { strategize: number };
} {
  const calls = { strategize: 0 };
  const llm = {
    strategizeJson: async (args: { validate: (v: unknown) => unknown }) => {
      calls.strategize += 1;
      return args.validate({ routes: modelRoutes });
    },
  } as unknown as LlmService;
  return { llm, calls };
}

const fakePages: PageContentPort = {
  async getPageContent() {
    return { wordCount: 800, headings: 6, images: 3, internalLinks: 10, externalLinks: 2 };
  },
};

describe("SEOContentBlueprint — strategic reasoning, exact lineage", () => {
  it("references the EXACT CompetitiveLandscape artifact", async () => {
    const landscape = makeLandscape();
    const { llm } = fakeLlm([blueprintRoute("home", "/")]);
    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: landscape,
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.payload.competitive_landscape_ref).toEqual(refForArtifact(landscape));
    expect(artifact.input_refs).toEqual([refForArtifact(landscape)]);
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
  });

  it("uses the strategic-reasoning path (strategizeJson), not extraction", async () => {
    const { llm, calls } = fakeLlm([blueprintRoute("home", "/")]);
    await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(calls.strategize).toBe(1);
  });

  it("seals the shared SEOContentBlueprint schema with exactly the requested routes", async () => {
    const { llm } = fakeLlm([blueprintRoute("home", "/")]);
    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.payload.schema).toBe(WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint);
    expect(artifact.payload.routes.map((r) => r.route_id)).toEqual(["home"]);
  });

  it("re-asserts route identity from the request (model cannot invent routes/paths)", async () => {
    // Model returns a route with a tampered path + an extra unexpected route.
    const tampered = blueprintRoute("home", "/WRONG");
    const extra = blueprintRoute("ghost", "/ghost");
    const { llm } = fakeLlm([tampered, extra]);
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes: requestedRoutes,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/Unexpected route_id/);
  });

  it("carries only the CompetitiveLandscape as an input ref (no WebsiteBuildBlueprint dependency)", async () => {
    const { llm } = fakeLlm([blueprintRoute("home", "/")]);
    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.input_refs).toHaveLength(1);
    expect(artifact.input_refs[0]!.artifact_type).toBe("competitive_landscape");
  });

  it("prompts with the nested route_shape the schema enforces (regression: flat journey_stage contract made every live call fail schema validation)", async () => {
    let capturedUserPrompt: string | null = null;
    const llm = {
      strategizeJson: async (args: {
        systemPrompt: string;
        userPrompt: string;
        validate: (v: unknown) => unknown;
      }) => {
        capturedUserPrompt = args.userPrompt;
        return args.validate({ routes: [blueprintRoute("home", "/")] });
      },
    } as unknown as LlmService;
    await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    const contract = JSON.parse(capturedUserPrompt!).output_contract;
    expect(contract.route_shape.search_intent.journey_stage).toContain("informational");
    expect(contract.route_shape.targets.primary_query).toBeTruthy();
    expect(contract.journey_stage).toBeUndefined();
  });

  it("batches 29 routes into 8 batches of 4 and persists batch_size/batch_count (oracle: 4 and 8)", async () => {
    const requested = Array.from({ length: 29 }, (_, i) => ({
      route_id: `route-${i + 1}`,
      path: `/route-${i + 1}`,
      purpose: "content",
    }));
    const modelRoutes = requested.map((r) => blueprintRoute(r.route_id, r.path));
    const calls = { strategize: 0 };
    const llm = {
      strategizeJson: async (args: { userPrompt: string; validate: (v: unknown) => unknown }) => {
        calls.strategize += 1;
        // Each strategize call must return EXACTLY its batch's routes — the
        // reconcile step rejects routes from other batches.
        const batchIds = new Set(
          JSON.parse(args.userPrompt).output_contract.one_entry_per_route_id as string[],
        );
        return args.validate({ routes: modelRoutes.filter((r) => batchIds.has(r.route_id)) });
      },
    } as unknown as LlmService;

    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requested,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(calls.strategize).toBe(8); // ceil(29 / 4)
    expect(artifact.payload.batch_size).toBe(4);
    expect(artifact.payload.batch_count).toBe(8);
    expect(artifact.payload.routes.map((r) => r.route_id)).toEqual(
      requested.map((r) => r.route_id),
    );
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
  });

  it("enforces batch membership: a route produced for another batch is rejected", async () => {
    const requested = Array.from({ length: 5 }, (_, i) => ({
      route_id: `route-${i + 1}`,
      path: `/route-${i + 1}`,
      purpose: "content",
    }));
    const modelRoutes = requested.map((r) => blueprintRoute(r.route_id, r.path));
    const llm = {
      strategizeJson: async (args: { validate: (v: unknown) => unknown }) => {
        // Wrong-batch answer: always return route-5 regardless of the batch
        // the producer asked for. Batch 1 (routes 1-4) must reject it.
        return args.validate({ routes: [modelRoutes[4]!] });
      },
    } as unknown as LlmService;
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes: requested,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/Unexpected route_id/);
  });
});

describe("SEOContentBlueprint — input gates", () => {
  function landscapeWith(
    mutate: (payload: CompetitiveLandscapeV1) => void,
  ): CompetitiveLandscapeArtifact {
    const base = makeLandscape();
    const payload = structuredClone(base.payload);
    mutate(payload);
    return sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: { repo: "SEO-Bot", version: "2.1.0" },
      payload,
    });
  }

  async function build(
    overrides: Partial<Parameters<typeof createSEOContentBlueprint>[0]>,
    routes: SEOContentBlueprintRoute[] = [blueprintRoute("home", "/")],
  ) {
    const { llm } = fakeLlm(routes);
    return createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
        ...overrides,
      },
      { llm, dataForSeo: fakePages },
    );
  }

  it("refuses to build on a landscape that is not evidence_complete", async () => {
    await expect(
      build({
        competitive_landscape: landscapeWith((p) => {
          p.evidence_complete = false;
        }),
      }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_LANDSCAPE_INVALID" });
  });

  it("refuses to build on a landscape with no selected donors", async () => {
    await expect(
      build({
        competitive_landscape: landscapeWith((p) => {
          p.selected_donors = [];
        }),
      }),
    ).rejects.toMatchObject({ code: "COMPETITIVE_LANDSCAPE_INVALID" });
  });

  it("rejects a tampered landscape before any LLM call", async () => {
    const landscape = makeLandscape();
    (landscape.payload as { evidence_complete: boolean }).evidence_complete = true;
    landscape.payload.selected_donors[0]!.domain = "tampered.com";
    await expect(build({ competitive_landscape: landscape })).rejects.toThrow(
      /INTEL_ARTIFACT_HASH_MISMATCH/,
    );
  });

  it("rejects an empty or duplicated requested route set", async () => {
    await expect(build({ routes: [] })).rejects.toMatchObject({ code: "ROUTE_SET_MISMATCH" });
    await expect(
      build({
        routes: [
          { route_id: "home", path: "/", purpose: "a" },
          { route_id: "home", path: "/b", purpose: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ROUTE_SET_MISMATCH" });
  });
});

describe("SEOContentBlueprint — deterministic output validation", () => {
  async function buildWith(routes: SEOContentBlueprintRoute[], requested = requestedRoutes) {
    const { llm } = fakeLlm(routes);
    return createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requested,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
  }

  it("rejects an invented content slot", async () => {
    const bad = blueprintRoute("home", "/");
    (bad.requirements[0] as { target_slots: string[] }).target_slots = ["hero_banner"];
    await expect(buildWith([bad])).rejects.toThrow();
  });

  it("accepts every slot in the shared ContentSlot vocabulary", async () => {
    const ok = blueprintRoute("home", "/");
    ok.requirements[0]!.target_slots = [
      "primary_offer",
      "service_overview",
      "differentiation",
      "trust",
      "process",
      "project_proof",
      "local_relevance",
      "objection_handling",
      "faq",
      "conversion",
      "metadata",
    ];
    const artifact = await buildWith([ok]);
    expect(artifact.payload.routes[0]!.requirements[0]!.target_slots).toHaveLength(11);
  });

  it("rejects a requirement that targets no slot", async () => {
    const bad = blueprintRoute("home", "/");
    bad.requirements[0]!.target_slots = [];
    await expect(buildWith([bad])).rejects.toThrow(/targets no content slot/);
  });

  it("rejects an internal link to a route that does not exist", async () => {
    const bad = blueprintRoute("home", "/");
    bad.internal_links = [{ target_route_id: "nowhere", purpose: "x" }];
    await expect(buildWith([bad])).rejects.toThrow(/unknown target_route_id/);
  });

  it("accepts an internal link to another requested route", async () => {
    const requested = [
      { route_id: "home", path: "/", purpose: "primary landing" },
      { route_id: "services", path: "/services", purpose: "services" },
    ];
    const home = blueprintRoute("home", "/");
    home.internal_links = [{ target_route_id: "services", purpose: "deepen" }];
    const artifact = await buildWith([home, blueprintRoute("services", "/services")], requested);
    expect(artifact.payload.routes[0]!.internal_links[0]!.target_route_id).toBe("services");
  });

  it("rejects a route that links to itself", async () => {
    const bad = blueprintRoute("home", "/");
    bad.internal_links = [{ target_route_id: "home", purpose: "loop" }];
    await expect(buildWith([bad])).rejects.toThrow(/links to itself/);
  });

  it("rejects duplicate requirement ids within a route", async () => {
    const bad = blueprintRoute("home", "/");
    bad.requirements = [bad.requirements[0]!, structuredClone(bad.requirements[0]!)];
    await expect(buildWith([bad])).rejects.toThrow(/duplicate requirement_id/);
  });

  it("rejects a missing route from model output", async () => {
    const requested = [
      { route_id: "home", path: "/", purpose: "primary landing" },
      { route_id: "services", path: "/services", purpose: "services" },
    ];
    await expect(buildWith([blueprintRoute("home", "/")], requested)).rejects.toThrow(
      /Missing blueprint for required route_id: services/,
    );
  });

  it("preserves forbidden claims from model output verbatim", async () => {
    const route = blueprintRoute("home", "/");
    route.forbidden_claims = ["cheapest in town", "lifetime free"];
    const artifact = await buildWith([route]);
    expect(artifact.payload.routes[0]!.forbidden_claims).toEqual([
      "cheapest in town",
      "lifetime free",
    ]);
  });
});
