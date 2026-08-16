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
    createCompetitiveLandscape: vi.fn(async () => artifact),
    CompetitiveEvidenceIncompleteError: class extends Error {
      code = "COMPETITIVE_EVIDENCE_INCOMPLETE";
    },
  };
});
vi.mock("../../src/build-intelligence/seo-content-blueprint.js", () => ({
  createSEOContentBlueprint: vi.fn(),
}));
vi.mock("../../src/build-intelligence/structured-content.js", () => ({
  createStructuredContentPackage: vi.fn(),
  ContentRequirementUnsatisfiedError: class extends Error {
    code = "CONTENT_REQUIREMENT_UNSATISFIED";
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

const AUTH = { authorization: "Bearer op-key" };

describe("POST /api/build-intelligence/competitive-landscape", () => {
  it("enforces operator authentication (401 without credentials)", async () => {
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
