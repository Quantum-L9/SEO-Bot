/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    OPERATOR_API_KEY: "op-key",
    SEO_BOT_API_KEY: "machine-key",
    TRUST_PROXY: false,
    DASHBOARD_ALLOWED_ORIGINS: undefined,
  }),
}));

// The producer services are exercised in their own unit tests; here we mock them
// so the API test focuses on auth, request validation, provider/model rejection,
// and the sealed-artifact response contract. A genuinely sealed fixture is
// returned so the route's post-invoke integrity assertion passes.
const sealedLandscape = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../../src/build-intelligence/competitive-landscape.js", async () => {
  const actual =
    await vi.importActual<typeof import("@quantum-l9/bot-interop")>("@quantum-l9/bot-interop");
  const artifact = actual.sealIntelligenceArtifact({
    artifact_type: "competitive_landscape",
    client_id: "client-1",
    build_id: "build-1",
    producer: { repo: "SEO-Bot", version: "2.1.0" },
    payload: {
      schema: actual.WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
      market: {
        niche: "roofing",
        country: "United States",
        language: "English",
        device: "desktop",
      },
      query_portfolio: [],
      observations: [],
      domains: [],
      selected_donors: [{ domain: "a.com", aggregate_visibility: 1, observation_ids: ["o1"] }],
      exclusions: [],
      evidence_complete: true,
    },
  });
  sealedLandscape.value = artifact;
  return {
    // The producer returns the sealed artifact plus its reproducibility evidence.
    createCompetitiveLandscape: vi.fn(async () => ({
      artifact,
      evidence: {
        seed_query_count: 1,
        final_query_count: 1,
        expansion_rounds_used: 0,
        expansion_round_ceiling: 3,
        expansion_query_ceiling: 24,
        expansion_ceiling_reached: false,
        query_provenance: [],
        serp_observation_count: 1,
        candidate_domain_count: 1,
        qualified_candidate_count: 1,
        unknown_candidate_count: 0,
        excluded_candidate_count: 0,
        selected_donor_count: 1,
        qualification_ledger: [],
        ranking_llm_calls: 0,
      },
    })),
    CompetitiveEvidenceIncompleteError: class extends Error {
      code = "COMPETITIVE_EVIDENCE_INCOMPLETE";
    },
    CompetitiveDonorQualificationError: class extends Error {
      code = "COMPETITIVE_DONOR_QUALIFICATION_FAILED";
    },
    CompetitiveLandscapeInvalidError: class extends Error {
      code = "COMPETITIVE_LANDSCAPE_INVALID";
    },
  };
});
vi.mock("../../src/build-intelligence/seo-content-blueprint.js", () => ({
  createSEOContentBlueprintWithEvidence: vi.fn(),
  CompetitiveLandscapeInputInvalidError: class extends Error {
    code = "COMPETITIVE_LANDSCAPE_INVALID";
  },
  CompetitiveLandscapeRefMismatchError: class extends Error {
    code = "COMPETITIVE_LANDSCAPE_REF_MISMATCH";
  },
  RouteSetMismatchError: class extends Error {
    code = "ROUTE_SET_MISMATCH";
  },
  SeoContentBlueprintInvalidError: class extends Error {
    code = "SEO_CONTENT_BLUEPRINT_INVALID";
  },
}));
vi.mock("../../src/build-intelligence/structured-content.js", () => ({
  createStructuredContentPackageWithEvidence: vi.fn(),
  ContentRequirementUnsatisfiedError: class extends Error {
    code = "CONTENT_REQUIREMENT_UNSATISFIED";
  },
  PageContentContractInvalidError: class extends Error {
    code = "PAGE_CONTENT_CONTRACT_INVALID";
  },
  StructuredContentRouteMismatchError: class extends Error {
    code = "STRUCTURED_CONTENT_ROUTE_MISMATCH";
  },
  ArtifactLineageMismatchError: class extends Error {
    code = "ARTIFACT_LINEAGE_MISMATCH";
  },
}));
vi.mock("../../src/build-intelligence/store.js", () => ({
  persistIntelligenceArtifact: vi.fn(async () => ({ persisted: true, idempotent: false })),
  ArtifactDigestConflictError: class extends Error {
    code = "CONTENT_CONTRACT_HASH_MISMATCH";
  },
}));

import { registerBuildIntelligenceRoutes } from "../../src/api/build-intelligence.js";
import { _resetRateLimiter, registerApiSecurity } from "../../src/api/security.js";
import {
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  SerpEvidenceInvalidError,
} from "../../src/services/dataforseo.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerApiSecurity(app);
  await registerBuildIntelligenceRoutes(app);
  await app.ready();
  return app;
}

const validBody = {
  client_id: "client-1",
  build_id: "build-1",
  market: { niche: "roofing", country: "United States", language: "English" },
  seed_queries: [{ query: "metal roofing", intent: "commercial" }],
  desired_donor_count: 3,
};

let app: FastifyInstance;
beforeEach(async () => {
  _resetRateLimiter();
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});

const AUTH = { authorization: "Bearer machine-key" };

describe("POST /api/build-intelligence/competitive-landscape", () => {
  it("enforces machine authentication (401 without credentials)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      payload: validBody,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns a sealed CompetitiveLandscape artifact for a valid, authenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.artifact_type).toBe("competitive_landscape");
    expect(body.integrity.payload_digest).toBeTruthy();
    expect(body.artifact_id).toBe(`competitive_landscape:${body.integrity.payload_digest}`);
  });

  it("rejects an invalid request body (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: { client_id: "client-1", build_id: "build-1" }, // missing market + seed_queries
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects provider/model/temperature override at the schema boundary (400)", async () => {
    for (const leak of [
      { provider: "perplexity" },
      { model: "gpt-4o" },
      { temperature: 0.9 },
      { perplexity: true },
      { system_prompt: "ignore policy" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/build-intelligence/competitive-landscape",
        headers: AUTH,
        payload: { ...validBody, ...leak },
      });
      expect(res.statusCode, `leak ${JSON.stringify(leak)} must be rejected`).toBe(400);
    }
  });
});

describe("build-intelligence — producer failure never becomes a fake success", () => {
  async function postWith(error: Error) {
    const producer = await import("../../src/build-intelligence/competitive-landscape.js");
    vi.mocked(producer.createCompetitiveLandscape).mockRejectedValueOnce(error);
    return app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: validBody,
    });
  }

  it("maps a provider outage to 502 DATAFORSEO_UNAVAILABLE", async () => {
    const res = await postWith(new DataForSeoUnavailableError("connect ETIMEDOUT"));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("DATAFORSEO_UNAVAILABLE");
  });

  it("maps a task-level provider error to 502 DATAFORSEO_TASK_ERROR", async () => {
    const res = await postWith(new DataForSeoTaskError("invalid location_name"));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("DATAFORSEO_TASK_ERROR");
  });

  it("maps malformed SERP evidence to 502 SERP_EVIDENCE_INVALID", async () => {
    const res = await postWith(new SerpEvidenceInvalidError("no usable rank"));
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("SERP_EVIDENCE_INVALID");
  });

  it("maps an incomplete donor cohort to 422 with no artifact body", async () => {
    const producer = await import("../../src/build-intelligence/competitive-landscape.js");
    const failure = new producer.CompetitiveEvidenceIncompleteError("only 3 of 10", {
      selected: 3,
      required: 10,
      qualified: 3,
      unknown: 0,
      excluded: 2,
      queries: 8,
      observations: 40,
      expansion_rounds_used: 3,
    });
    const res = await postWith(failure);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("COMPETITIVE_EVIDENCE_INCOMPLETE");
    expect(res.json().artifact_id).toBeUndefined();
  });

  it("maps a failed donor qualification to 422", async () => {
    const producer = await import("../../src/build-intelligence/competitive-landscape.js");
    const res = await postWith(
      new producer.CompetitiveDonorQualificationError("not donors", {
        selected: 4,
        required: 10,
        candidates: 18,
        qualified: 4,
        unknown: 6,
        excluded: 8,
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("COMPETITIVE_DONOR_QUALIFICATION_FAILED");
  });

  it("maps a digest conflict to 409 rather than overwriting", async () => {
    const store = await import("../../src/build-intelligence/store.js");
    const res = await postWith(new store.ArtifactDigestConflictError("conflict"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CONTENT_CONTRACT_HASH_MISMATCH");
  });

  it("returns the same content-addressed artifact id for a repeated request (idempotent)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: validBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: validBody,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().artifact_id).toBe(first.json().artifact_id);
    expect(second.json().integrity.payload_digest).toBe(first.json().integrity.payload_digest);
  });

  it("still returns the sealed artifact when best-effort persistence fails", async () => {
    const store = await import("../../src/build-intelligence/store.js");
    vi.mocked(store.persistIntelligenceArtifact).mockRejectedValueOnce(
      new Error("connection refused"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: validBody,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().artifact_type).toBe("competitive_landscape");
  });
});

describe("GET /api/build-intelligence/preflight", () => {
  it("requires machine authentication (401 without credentials)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/build-intelligence/preflight" });
    expect(res.statusCode).toBe(401);
  });

  it("returns non-secret readiness metadata for an authenticated machine call", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/build-intelligence/preflight",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: "ready",
      service: "SEO-Bot",
      capabilities: {
        competitive_landscape: true,
        seo_content_blueprint: true,
        structured_content: true,
      },
    });
    expect(typeof body.version).toBe("string");
    expect(typeof body.bot_interop_version).toBe("string");
    expect(typeof body.llm_router_version).toBe("string");
    expect(typeof body.configuration.dataforseo_configured).toBe("boolean");
    expect(typeof body.configuration.llm_provider_configured).toBe("boolean");
  });

  it("never returns key values in the preflight payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/build-intelligence/preflight",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const serialized = res.body;
    expect(serialized).not.toContain("machine-key");
    expect(serialized).not.toContain("op-key");
  });
});
