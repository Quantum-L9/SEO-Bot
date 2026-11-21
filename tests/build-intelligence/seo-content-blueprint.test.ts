/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  FIRST_PARTY_AUTHORITY_SCHEMA,
  refForArtifact,
  type SEOContentBlueprintRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  chunkRoutes,
  createSEOContentBlueprint,
  createSEOContentBlueprintWithEvidence,
  describeBatchFailure,
  type PageContentPort,
  SEO_BLUEPRINT_BATCH_SIZE,
} from "../../src/build-intelligence/seo-content-blueprint.js";
import type { LlmService } from "../../src/services/llm.js";
import { LlmOutputTruncatedError } from "../../src/services/llm-parse.js";

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
  calls: { strategize: number; prompts: string[] };
} {
  const calls = { strategize: 0, prompts: [] as string[] };
  const llm = {
    strategizeJson: async (args: { userPrompt: string; validate: (v: unknown) => unknown }) => {
      calls.strategize += 1;
      calls.prompts.push(args.userPrompt);
      if (calls.strategize === 1) {
        // Phase A — the global route intent plan, derived from the REQUESTED
        // route set (the request is the identity authority), falling back to a
        // unique query when the model has no route for an id.
        const prompt = JSON.parse(args.userPrompt) as {
          routes: Array<{ route_id: string }>;
        };
        const byId = new Map(modelRoutes.map((route) => [route.route_id, route]));
        const intents = prompt.routes.map((route) => {
          const model = byId.get(route.route_id);
          return {
            route_id: route.route_id,
            primary_query: model?.targets.primary_query ?? `query for ${route.route_id}`,
            primary_intent: model?.search_intent.primary ?? "commercial",
            journey_stage: model?.search_intent.journey_stage ?? "commercial",
          };
        });
        return args.validate({ routes: intents });
      }
      // Phase B — return only the routes of the requested batch.
      const prompt = JSON.parse(args.userPrompt) as {
        current_batch: Array<{ route_id: string }>;
      };
      const batchIds = new Set(prompt.current_batch.map((route) => route.route_id));
      return args.validate({ routes: modelRoutes.filter((route) => batchIds.has(route.route_id)) });
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
  it("builds from routes and facts when research was not requested", async () => {
    const record = {
      schema: FIRST_PARTY_AUTHORITY_SCHEMA,
      market_research: "not_requested" as const,
      domain_spec_digest: "ab".repeat(32),
      donor_count: 0 as const,
    };
    const route = blueprintRoute("home", "/");
    route.competitive_gaps = [];
    const { llm } = fakeLlm([route]);
    const artifact = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        first_party_authority: record,
        routes: requestedRoutes,
        business_facts: [],
      },
      {
        llm,
        dataForSeo: {
          async getPageContent() {
            throw new Error("DataForSEO must not be called");
          },
        },
      },
    );
    expect(artifact.payload.competitive_landscape_ref).toBeUndefined();
    expect(artifact.payload.first_party_authority).toEqual(record);
    expect(artifact.input_refs).toEqual([]);
    expect(artifact.payload.routes[0]?.competitive_gaps).toEqual([]);
  });

  it("rejects invented donor domains when research was not requested", async () => {
    const record = {
      schema: FIRST_PARTY_AUTHORITY_SCHEMA,
      market_research: "not_requested" as const,
      domain_spec_digest: "ab".repeat(32),
      donor_count: 0 as const,
    };
    const { llm } = fakeLlm([blueprintRoute("home", "/")]);
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          first_party_authority: record,
          routes: requestedRoutes,
          business_facts: [],
        },
        {
          llm,
          dataForSeo: {
            async getPageContent() {
              throw new Error("DataForSEO must not be called");
            },
          },
        },
      ),
    ).rejects.toThrow(/must not carry competitive gaps/);
  });

  it("rejects a competitive gap that names no donors when research was not requested", async () => {
    const record = {
      schema: FIRST_PARTY_AUTHORITY_SCHEMA,
      market_research: "not_requested" as const,
      domain_spec_digest: "ab".repeat(32),
      donor_count: 0 as const,
    };
    const route = blueprintRoute("home", "/");
    route.competitive_gaps = [
      {
        gap_id: "g1",
        description: "no pricing",
        donor_domains: [],
        opportunity: "add pricing",
      },
    ];
    const { llm } = fakeLlm([route]);
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          first_party_authority: record,
          routes: requestedRoutes,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/must not carry competitive gaps/);
  });

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
    expect(calls.strategize).toBe(2); // phase A + one deterministic batch
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
    // A tampered path is corrected by re-assertion from the request…
    const tampered = blueprintRoute("home", "/WRONG");
    const { llm } = fakeLlm([tampered]);
    const corrected = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: requestedRoutes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    expect(corrected.payload.routes[0]!.path).toBe("/");

    // …and an invented route_id in a batch's output fails the batch.
    const extra = blueprintRoute("ghost", "/ghost");
    const customLlm = {
      strategizeJson: async (args: { userPrompt: string; validate: (v: unknown) => unknown }) => {
        const prompt = JSON.parse(args.userPrompt) as { task?: string };
        if (prompt.task === "global_route_intent_plan") {
          return args.validate({
            routes: [
              {
                route_id: "home",
                primary_query: "metal roofing",
                primary_intent: "commercial",
                journey_stage: "commercial",
              },
            ],
          });
        }
        return args.validate({ routes: [extra] });
      },
    } as unknown as LlmService;
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes: requestedRoutes,
          business_facts: [],
        },
        { llm: customLlm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/outside this batch/);
  });

  it("carries only the CompetitiveLandscape as an input ref (no WebsiteBuildBlueprintV2 dependency)", async () => {
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

  it("prompts batches with the nested route_shape the schema enforces (regression: flat journey_stage contract made every live call fail schema validation)", async () => {
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
    const batchPrompt = JSON.parse(calls.prompts[1]!);
    expect(batchPrompt.task).toBe("seo_content_blueprint_batch");
    expect(batchPrompt.all_route_index).toHaveLength(1);
    expect(batchPrompt.global_route_intent_plan).toHaveLength(1);
    const contract = batchPrompt.output_contract;
    // journey_stage renders as an exact enum value a model can copy; the
    // instruction to reassert it from the intent plan travels as a rule.
    expect(["informational", "commercial", "transactional"]).toContain(
      contract.route_shape.search_intent.journey_stage,
    );
    expect(contract.rules).toContain(
      "route_shape.search_intent.journey_stage: reassert the journey_stage from the global intent plan.",
    );
    expect(contract.route_shape.targets.primary_query).toBeTruthy();
    expect(contract.journey_stage).toBeUndefined();
    // Identity fields are schema-required on the model's raw output
    // (seoContentBlueprintRoutesSchema), so the contract must demand them —
    // a live run failed when the model dropped `path` and the one bounded
    // repair could not recover it.
    expect(contract.route_shape.route_id).toContain("reassert");
    expect(contract.route_shape.path).toContain("reassert");
    // The container shape must be named too: a live run's batch returned a
    // bare array (mirroring the global plan's array shape) and its repair
    // returned a path-keyed map — the contract had never stated the
    // { routes: [...] } root.
    // The root renders as a copyable `{ routes: [] }` and the instruction that
    // `routes` is the only top-level key travels as a rule.
    expect(Object.keys(contract.container)).toEqual(["routes"]);
    expect(contract.container.routes).toEqual([]);
    expect(contract.rules.some((rule: string) => rule.includes("ONLY top-level key"))).toBe(true);
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
        const prompt = JSON.parse(args.userPrompt);
        // PHASE A: the global route intent plan — one entry per route.
        if (prompt.task === "global_route_intent_plan") {
          return args.validate({
            routes: requested.map((r) => ({
              route_id: r.route_id,
              primary_query: `query-${r.route_id}`,
              primary_intent: "informational",
              journey_stage: "informational",
            })),
          });
        }
        calls.strategize += 1;
        // Each batch call must return EXACTLY its batch's routes — the
        // reconcile step rejects routes from other batches.
        const batchIds = new Set(prompt.output_contract.one_entry_per_route_id as string[]);
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
      strategizeJson: async (args: { userPrompt: string; validate: (v: unknown) => unknown }) => {
        const prompt = JSON.parse(args.userPrompt);
        if (prompt.task === "global_route_intent_plan") {
          return args.validate({
            routes: requested.map((r) => ({
              route_id: r.route_id,
              primary_query: `query-${r.route_id}`,
              primary_intent: "informational",
              journey_stage: "informational",
            })),
          });
        }
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
    ).rejects.toThrow(/outside this batch/);
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
    const services = blueprintRoute("services", "/services");
    services.targets = { ...services.targets, primary_query: "metal roof services" };
    const artifact = await buildWith([home, services], requested);
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

describe("SEOContentBlueprint — full-site batching (two-phase)", () => {
  function routesFor(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      route_id: `route-${index + 1}`,
      path: `/route-${index + 1}`,
      purpose: `purpose ${index + 1}`,
    }));
  }

  function modelRoutesFor(count: number): SEOContentBlueprintRoute[] {
    return routesFor(count).map((route, index) => ({
      ...blueprintRoute(route.route_id, route.path),
      targets: {
        ...blueprintRoute(route.route_id, route.path).targets,
        primary_query: `query ${index + 1}`,
      },
    }));
  }

  function build(
    routes: Array<{ route_id: string; path: string; purpose: string }>,
    model: SEOContentBlueprintRoute[],
  ) {
    const { llm, calls } = fakeLlm(model);
    return createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    ).then((artifact) => ({ artifact, calls }));
  }

  it.each([1, 4, 5, 8, 29, 40])(
    "seals one blueprint for %i routes with exact coverage",
    async (count) => {
      const routes = routesFor(count);
      const { artifact, calls } = await build(routes, modelRoutesFor(count));
      expect(artifact.payload.routes).toHaveLength(count);
      expect(artifact.payload.routes.map((route) => route.route_id)).toEqual(
        routes.map((route) => route.route_id),
      );
      const expectedBatches = Math.ceil(count / 4);
      expect(calls.strategize).toBe(1 + expectedBatches); // phase A + deterministic batches
      expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
    },
  );

  it("fails the whole artifact when a batch is missing a route", async () => {
    const routes = routesFor(5);
    // Batch 2 (route-5) will come back empty → its validator throws.
    const model = modelRoutesFor(4); // missing route-5
    await expect(build(routes, model)).rejects.toMatchObject({
      code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID",
    });
  });

  it("fails the whole artifact when a batch returns another batch's route", async () => {
    const routes = routesFor(5);
    const model = modelRoutesFor(5).map((route) =>
      route.route_id === "route-5" ? { ...route, route_id: "route-4" } : route,
    );
    // Batch 2's output contains route-4 (outside the batch) and misses route-5.
    const { llm, calls } = fakeLlm(model);
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toMatchObject({ code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID" });
    expect(calls.strategize).toBeGreaterThan(1);
  });

  it("allows cross-batch internal links to any site route and rejects unknown targets", async () => {
    const routes = routesFor(5);
    const model = modelRoutesFor(5);
    // route-1 (batch 1) links to route-5 (batch 2) — valid.
    model[0]!.internal_links = [{ target_route_id: "route-5", purpose: "cross-batch" }];
    const { artifact } = await build(routes, model);
    expect(artifact.payload.routes[0]!.internal_links[0]!.target_route_id).toBe("route-5");

    const badModel = modelRoutesFor(5);
    badModel[0]!.internal_links = [{ target_route_id: "route-999", purpose: "ghost" }];
    await expect(build(routes, badModel)).rejects.toMatchObject({
      code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID",
    });
  });

  it("fails the whole artifact on a duplicate normalized primary_query in the global plan", async () => {
    const routes = routesFor(5);
    const model = modelRoutesFor(5).map((route, index) =>
      index === 1 ? { ...route, targets: { ...route.targets, primary_query: "query 1" } } : route,
    );
    const { llm } = fakeLlm(model);
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/duplicate primary_query/);
  });

  it("fails the whole artifact when a batch fails its bounded repair", async () => {
    const routes = routesFor(5);
    let batchCalls = 0;
    const llm = {
      strategizeJson: async (args: { userPrompt: string; validate: (v: unknown) => unknown }) => {
        const prompt = JSON.parse(args.userPrompt) as { task?: string };
        if (prompt.task === "global_route_intent_plan") {
          return args.validate({
            routes: routesFor(5).map((route, index) => ({
              route_id: route.route_id,
              primary_query: `query ${index + 1}`,
              primary_intent: "commercial",
              journey_stage: "commercial",
            })),
          });
        }
        batchCalls += 1;
        if (batchCalls === 2) throw new Error("repair exhausted");
        return args.validate({
          routes: modelRoutesFor(5).filter((route) =>
            (
              JSON.parse(args.userPrompt) as { current_batch: Array<{ route_id: string }> }
            ).current_batch.some((r) => r.route_id === route.route_id),
          ),
        });
      },
    } as unknown as LlmService;
    await expect(
      createSEOContentBlueprint(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes,
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toMatchObject({ code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID" });
  });

  it("sizes every call's output cap from its own route count (per-route budget × routes)", async () => {
    const routes = routesFor(9);
    const { llm: inner } = fakeLlm(modelRoutesFor(9));
    const caps: Array<number | undefined> = [];
    const llm = {
      strategizeJson: (args: Parameters<LlmService["strategizeJson"]>[0]) => {
        caps.push(args.expectedOutputTokens);
        return inner.strategizeJson(args);
      },
    } as unknown as LlmService;
    await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    // Phase A keeps the 5,000 floor; full 4-route batches get 500 + 3,500 × 4;
    // the 1-route tail batch gets 500 + 3,500.
    expect(caps).toEqual([5000, 14_500, 14_500, 4000]);
  });

  it("a truncated batch fails closed with the typed truncation error — not relabelled, no later batch", async () => {
    const routes = routesFor(9);
    const { llm: inner } = fakeLlm(modelRoutesFor(9));
    let batchCalls = 0;
    const llm = {
      strategizeJson: (args: Parameters<LlmService["strategizeJson"]>[0]) => {
        const prompt = JSON.parse(args.userPrompt) as { task?: string };
        if (prompt.task === "global_route_intent_plan") return inner.strategizeJson(args);
        batchCalls += 1;
        throw new LlmOutputTruncatedError({
          operation: "SEO_CONTENT_BLUEPRINT",
          purpose: `[${args.module}] ${args.purpose}`,
          attempt: "initial",
          maxOutputTokens: args.expectedOutputTokens ?? 0,
          outputTokens: args.expectedOutputTokens ?? 0,
          finishReason: "length",
          responseLength: 65_000,
        });
      },
    } as unknown as LlmService;
    const error = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmOutputTruncatedError);
    expect((error as LlmOutputTruncatedError).code).toBe("LLM_OUTPUT_TRUNCATED");
    expect((error as LlmOutputTruncatedError).purpose).toContain("batch-1");
    expect((error as LlmOutputTruncatedError).maxOutputTokens).toBe(14_500);
    expect(batchCalls).toBe(1);
  });

  /**
   * Run 5 routes (two batches) with phase A real and batch 1 driven by
   * `batchOne`, which receives the batch's own validator.
   */
  async function failBatchOne(
    batchOne: (args: Parameters<LlmService["strategizeJson"]>[0]) => unknown,
  ): Promise<unknown> {
    const routes = routesFor(5);
    const { llm: inner } = fakeLlm(modelRoutesFor(5));
    const llm = {
      strategizeJson: async (args: Parameters<LlmService["strategizeJson"]>[0]) => {
        const prompt = JSON.parse(args.userPrompt) as { task?: string };
        if (prompt.task === "global_route_intent_plan") return inner.strategizeJson(args);
        return batchOne(args);
      },
    } as unknown as LlmService;
    return createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes,
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    ).catch((caught: unknown) => caught);
  }

  it("labels a reply that failed validation as a validation failure (historical text kept)", async () => {
    const error = await failBatchOne((args) => args.validate({ routes: [] }));
    expect(error).toMatchObject({ code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID" });
    expect((error as Error).message).toMatch(
      /^Batch 1 failed validation after its bounded repair: /,
    );
    expect((error as Error).message).not.toContain("transport");
  });

  it("labels a non-JSON reply as a validation failure", async () => {
    const error = await failBatchOne(() => {
      throw new Error("LLM did not return valid JSON (response length=12)");
    });
    expect((error as Error).message).toMatch(
      /^Batch 1 failed validation after its bounded repair: LLM did not return valid JSON/,
    );
  });

  it("labels a call that never produced a reply as a transport failure, not validation", async () => {
    const error = await failBatchOne(() => {
      throw new Error("All OpenRouter fallback attempts failed");
    });
    expect(error).toMatchObject({ code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID" });
    const message = (error as Error).message;
    expect(message).toBe(
      "Batch 1 LLM call failed before any reply was validated " +
        "(transport failure, not a validation failure): All OpenRouter fallback attempts failed",
    );
    expect(message).not.toContain("failed validation after its bounded repair");
  });

  it("labels a repair call that timed out after a rejected reply as a transport failure during repair", async () => {
    const error = await failBatchOne((args) => {
      // Initial reply rejected by the validator, then the repair call times out.
      try {
        args.validate({ routes: [] });
      } catch {
        // swallowed exactly as LlmService does before issuing its repair call
      }
      throw new Error("The operation was aborted due to timeout");
    });
    expect((error as Error).message).toBe(
      "Batch 1 LLM call failed during its bounded repair " +
        "(transport failure, not a validation failure): The operation was aborted due to timeout",
    );
  });

  it("never seals a partial route set", async () => {
    const routes = routesFor(29);
    const model = modelRoutesFor(29);
    // Drop the final batch's routes from the model — coverage 28/29 must fail.
    model.length = 28;
    await expect(build(routes, model)).rejects.toMatchObject({
      code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID",
    });
  });
});

describe("describeBatchFailure", () => {
  it("is a validation failure only when the final error is the validator's own rejection", () => {
    const rejection = new Error("route-5 missing");
    expect(describeBatchFailure(2, rejection, rejection)).toBe(
      "Batch 2 failed validation after its bounded repair: route-5 missing",
    );
    // A different error with the same text is not the validator's rejection.
    expect(describeBatchFailure(2, new Error("route-5 missing"), rejection)).toContain(
      "failed during its bounded repair",
    );
  });

  it("treats a non-Error throw as a transport failure with its string form", () => {
    expect(describeBatchFailure(3, "socket hang up", undefined)).toBe(
      "Batch 3 LLM call failed before any reply was validated " +
        "(transport failure, not a validation failure): socket hang up",
    );
  });
});

describe("SEOContentBlueprint — deterministic batch split", () => {
  it("chunks strictly by request order, final chunk short", () => {
    expect(chunkRoutes([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  });

  it("defaults to the producer batch size", () => {
    expect(SEO_BLUEPRINT_BATCH_SIZE).toBe(4);
    expect(chunkRoutes(Array.from({ length: 29 }, (_, i) => i)).map((c) => c.length)).toEqual([
      4, 4, 4, 4, 4, 4, 4, 1,
    ]);
  });

  it("returns no chunks for an empty route set", () => {
    expect(chunkRoutes([], 4)).toEqual([]);
  });
});

describe("SEOContentBlueprint — measured run evidence", () => {
  function routesFor(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      route_id: `route-${index + 1}`,
      path: `/route-${index + 1}`,
      purpose: `purpose ${index + 1}`,
    }));
  }

  function modelRoutesFor(count: number): SEOContentBlueprintRoute[] {
    return routesFor(count).map((route, index) => ({
      ...blueprintRoute(route.route_id, route.path),
      targets: {
        ...blueprintRoute(route.route_id, route.path).targets,
        primary_query: `query ${index + 1}`,
      },
    }));
  }

  function buildWithEvidence(count: number) {
    const { llm } = fakeLlm(modelRoutesFor(count));
    return createSEOContentBlueprintWithEvidence(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: routesFor(count),
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
  }

  it.each([1, 4, 5, 8, 29, 40])("counts the actual run for %i routes", async (count) => {
    const expectedBatches = Math.ceil(count / SEO_BLUEPRINT_BATCH_SIZE);
    const { artifact, evidence } = await buildWithEvidence(count);
    expect(evidence).toEqual({
      route_count: count,
      batch_size: SEO_BLUEPRINT_BATCH_SIZE,
      batch_count: expectedBatches,
      completed_batches: expectedBatches,
    });
    // The evidence describes the artifact that was actually sealed.
    expect(artifact.payload.routes).toHaveLength(count);
  });

  it("createSEOContentBlueprint returns exactly the artifact of the evidence sibling", async () => {
    const { llm } = fakeLlm(modelRoutesFor(5));
    const plain = await createSEOContentBlueprint(
      {
        client_id: "client-1",
        build_id: "build-1",
        competitive_landscape: makeLandscape(),
        routes: routesFor(5),
        business_facts: [],
      },
      { llm, dataForSeo: fakePages },
    );
    const { artifact } = await buildWithEvidence(5);
    expect(plain.payload).toEqual(artifact.payload);
  });

  it("never reports completed batches for a run that failed to seal", async () => {
    // Batch 2 comes back without route-5 → the whole artifact fails.
    const { llm } = fakeLlm(modelRoutesFor(4));
    await expect(
      createSEOContentBlueprintWithEvidence(
        {
          client_id: "client-1",
          build_id: "build-1",
          competitive_landscape: makeLandscape(),
          routes: routesFor(5),
          business_facts: [],
        },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toMatchObject({ code: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID" });
  });
});
