/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Batched SEOContentBlueprint generation: global route strategy (compact),
 * deterministic 4-route batches, batch-scoped reconciliation, deterministic
 * whole-site merge, and the evidence sibling API.
 */

import {
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  type SEOContentBlueprintRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";
import {
  chunkRoutes,
  createSEOContentBlueprintWithEvidence,
  SEO_BLUEPRINT_BATCH_SIZE,
  type PageContentPort,
} from "../../src/build-intelligence/seo-content-blueprint.js";
import type { GlobalRouteIntentRoute } from "../../src/build-intelligence/schema-guards.js";
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
        requirement_id: `req-${routeId}`,
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
        gap_id: `gap-${routeId}`,
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

function requestedRoutes(count: number): Array<{ route_id: string; path: string; purpose: string }> {
  return Array.from({ length: count }, (_, index) => ({
    route_id: `r${index + 1}`,
    path: `/r${index + 1}`,
    purpose: `purpose ${index + 1}`,
  }));
}

function validBatch(batch: Array<{ route_id: string; path: string }>) {
  return { routes: batch.map((route) => blueprintRoute(route.route_id, route.path)) };
}

function validGlobal(routes: Array<{ route_id: string }>): { routes: GlobalRouteIntentRoute[] } {
  return {
    routes: routes.map((route) => ({
      route_id: route.route_id,
      primary_query: "metal roofing",
      primary_intent: "commercial",
      journey_stage: "commercial" as const,
    })),
  };
}

const fakePages: PageContentPort = {
  async getPageContent() {
    return { wordCount: 800, headings: 6, images: 3, internalLinks: 10, externalLinks: 2 };
  },
};

/**
 * Queue-driven LLM mock at the strategizeJson boundary, emulating the policy
 * executor's embedded single repair: when args.validate throws, the next
 * queued response is consumed for the ONE repair attempt; a second failure is
 * terminal. `"throw"` simulates a transport-level failure.
 */
function queueLlm(responses: Array<{ routes: unknown[] } | "throw">) {
  let index = 0;
  const purposes: string[] = [];
  const llm = {
    strategizeJson: async (args: {
      purpose: string;
      validate: (value: unknown) => unknown;
    }) => {
      purposes.push(args.purpose);
      const consume = () => {
        const current = responses[index];
        index += 1;
        return current;
      };
      const first = consume();
      if (first === undefined || first === "throw") {
        throw new Error("simulated LLM transport failure");
      }
      try {
        return args.validate(first);
      } catch (error) {
        const repair = consume();
        if (repair === undefined || repair === "throw") {
          throw error;
        }
        // Second validation failure is terminal, mirroring executePolicyJson.
        return args.validate(repair);
      }
    },
  } as unknown as LlmService;
  return { llm, purposes };
}

async function build(count: number, responses: Array<{ routes: unknown[] } | "throw">) {
  const { llm, purposes } = queueLlm(responses);
  const result = await createSEOContentBlueprintWithEvidence(
    {
      client_id: "client-1",
      build_id: "build-1",
      competitive_landscape: makeLandscape(),
      routes: requestedRoutes(count),
      business_facts: [],
    },
    { llm, dataForSeo: fakePages },
  );
  return { result, purposes };
}

describe("chunkRoutes", () => {
  it("chunks deterministically by size in input order", () => {
    expect(chunkRoutes([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9],
    ]);
    expect(SEO_BLUEPRINT_BATCH_SIZE).toBe(4);
  });
});

describe("SEOContentBlueprint — batch-size matrix", () => {
  it("1 route: single batch, single strategic call, order preserved", async () => {
    const { result, purposes } = await build(1, [validBatch(requestedRoutes(1))]);
    expect(result.evidence).toMatchObject({
      route_count: 1,
      batch_size: 4,
      batch_count: 1,
      completed_batches: 1,
      missing_route_ids: [],
      extra_route_ids: [],
    });
    expect(purposes).toHaveLength(1);
    expect(purposes[0]).not.toContain("global-route-strategy");
    expect(result.artifact.payload.routes.map((r) => r.route_id)).toEqual(["r1"]);
  });

  it("4 routes: exactly one batch (fast path)", async () => {
    const { result, purposes } = await build(4, [validBatch(requestedRoutes(4))]);
    expect(result.evidence.batch_count).toBe(1);
    expect(purposes).toHaveLength(1);
    expect(result.artifact.payload.routes.map((r) => r.route_id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
  });

  it("5 routes: global plan + two deterministic batches (4 + 1)", async () => {
    const requested = requestedRoutes(5);
    const { result, purposes } = await build(5, [
      validGlobal(requested),
      validBatch(requested.slice(0, 4)),
      validBatch(requested.slice(4)),
    ]);
    expect(result.evidence.batch_count).toBe(2);
    expect(purposes).toHaveLength(3);
    expect(purposes[0]).toContain("global-route-strategy");
    expect(result.artifact.payload.routes.map((r) => r.route_id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
    ]);
  });

  it("8 routes: two batches of four", async () => {
    const requested = requestedRoutes(8);
    const { result } = await build(8, [
      validGlobal(requested),
      validBatch(requested.slice(0, 4)),
      validBatch(requested.slice(4)),
    ]);
    expect(result.evidence.batch_count).toBe(2);
    expect(result.artifact.payload.routes).toHaveLength(8);
  });

  it("29 routes: 8 batches (4+4+4+4+4+4+4+1), exactly 29 produced in original order", async () => {
    const requested = requestedRoutes(29);
    const batches = chunkRoutes(requested);
    const { result } = await build(29, [validGlobal(requested), ...batches.map(validBatch)]);
    expect(batches.map((b) => b.length)).toEqual([4, 4, 4, 4, 4, 4, 4, 1]);
    expect(result.evidence).toMatchObject({
      route_count: 29,
      batch_count: 8,
      completed_batches: 8,
    });
    expect(result.artifact.payload.routes.map((r) => r.route_id)).toEqual(
      requested.map((r) => r.route_id),
    );
    expect(result.artifact.payload.routes).toHaveLength(29);
  });

  it("40 routes: 10 batches", async () => {
    const requested = requestedRoutes(40);
    const { result } = await build(40, [
      validGlobal(requested),
      ...chunkRoutes(requested).map(validBatch),
    ]);
    expect(result.evidence.batch_count).toBe(10);
    expect(result.artifact.payload.routes).toHaveLength(40);
  });
});

describe("SEOContentBlueprint — batch reconciliation failures", () => {
  it("batch misses a route, repair completes it (repaired once)", async () => {
    const requested = requestedRoutes(5);
    const { result } = await build(5, [
      validGlobal(requested),
      validBatch(requested.slice(0, 4)),
      // batch 2 first response misses r5 → embedded repair returns the full batch.
      { routes: [] },
      validBatch(requested.slice(4)),
    ]);
    expect(result.artifact.payload.routes.map((r) => r.route_id)).toEqual(
      requested.map((r) => r.route_id),
    );
  });

  it("batch misses a route twice → terminal", async () => {
    const requested = requestedRoutes(5);
    await expect(
      build(5, [
        validGlobal(requested),
        validBatch(requested.slice(0, 4)),
        { routes: [] },
        { routes: [] },
      ]),
    ).rejects.toThrow(/Missing blueprint for required route_id: r5/);
  });

  it("batch adds a route from another batch → rejected, repair valid", async () => {
    const requested = requestedRoutes(5);
    const foreign = validBatch(requested.slice(0, 1));
    const { result } = await build(5, [
      validGlobal(requested),
      validBatch(requested.slice(0, 4)),
      { routes: [...foreign.routes] }, // r1 belongs to batch 1
      validBatch(requested.slice(4)),
    ]);
    expect(result.artifact.payload.routes).toHaveLength(5);
  });

  it("batch adds a route from another batch twice → terminal", async () => {
    const requested = requestedRoutes(5);
    const foreign = validBatch(requested.slice(0, 1));
    await expect(
      build(5, [
        validGlobal(requested),
        validBatch(requested.slice(0, 4)),
        { routes: [...foreign.routes] },
        { routes: [...foreign.routes] },
      ]),
    ).rejects.toThrow(/Unexpected route_id/);
  });

  it("cross-batch internal link is valid (batch 1 links to a batch 2 route)", async () => {
    const requested = requestedRoutes(5);
    const batch1 = validBatch(requested.slice(0, 4));
    batch1.routes[0]!.internal_links = [
      { target_route_id: "r5", purpose: "deepen" },
    ];
    const { result } = await build(5, [
      validGlobal(requested),
      batch1,
      validBatch(requested.slice(4)),
    ]);
    expect(result.artifact.payload.routes[0]!.internal_links[0]!.target_route_id).toBe("r5");
  });

  it("unknown internal-link target is invalid", async () => {
    const requested = requestedRoutes(5);
    const batch1 = validBatch(requested.slice(0, 4));
    batch1.routes[0]!.internal_links = [
      { target_route_id: "nowhere", purpose: "x" },
    ];
    await expect(build(5, [validGlobal(requested), batch1])).rejects.toThrow(
      /unknown target_route_id/,
    );
  });
});

describe("SEOContentBlueprint — global plan parity", () => {
  it("global plan missing a route → repaired once → success", async () => {
    const requested = requestedRoutes(5);
    const partial = validGlobal(requested.slice(0, 4));
    const { result } = await build(5, [
      partial,
      validGlobal(requested),
      validBatch(requested.slice(0, 4)),
      validBatch(requested.slice(4)),
    ]);
    expect(result.artifact.payload.routes).toHaveLength(5);
  });

  it("global plan missing a route twice → terminal", async () => {
    const requested = requestedRoutes(5);
    const partial = validGlobal(requested.slice(0, 4));
    await expect(
      build(5, [
        partial,
        partial,
        validBatch(requested.slice(0, 4)),
        validBatch(requested.slice(4)),
      ]),
    ).rejects.toThrow(/Missing global plan for required route_id: r5/);
  });

  it("global plan with an extra route → terminal after repair", async () => {
    const requested = requestedRoutes(5);
    const extra = validGlobal([
      ...requested,
      { route_id: "ghost" },
    ]);
    await expect(build(5, [extra, extra])).rejects.toThrow(/Unexpected route_id/);
  });

  it("global plan with a duplicate route_id → terminal", async () => {
    const requested = requestedRoutes(5);
    const dup = validGlobal([...requested, requested[0]!]);
    await expect(build(5, [dup, dup])).rejects.toThrow(/Duplicate route_id in global plan output/);
  });
});
