/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

/**
 * The production retrieval path for `l9.seo-bot-run-llm-audit/v1`.
 *
 * Website-Bot reads run evidence over the SAME machine-authenticated API
 * boundary it already uses for the three producers — `producer-seam-proof.ts`
 * is an offline evidence script and is never on this path.
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

import {
  RUN_ID_HEADER,
  registerBuildIntelligenceRoutes,
} from "../../src/api/build-intelligence.js";
import { _resetRateLimiter, registerApiSecurity } from "../../src/api/security.js";
import {
  _resetRunEvidenceStore,
  recordCompetitiveLandscapeLeg,
  recordSeoContentBlueprintLeg,
  recordStructuredContentLeg,
} from "../../src/build-intelligence/run-evidence-store.js";
import { RUN_LLM_AUDIT_SCHEMA, runIdFor } from "../../src/build-intelligence/run-llm-audit.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

const CLIENT = "client-1";
const BUILD = "build-1";
const AUTH = { authorization: "Bearer machine-key" };

function decision(taskId: string) {
  return [
    {
      taskId,
      clientId: CLIENT,
      timestamp: "2026-08-21T00:00:00.000Z",
      taskType: "strategic_reasoning",
      complexity: "high",
      provider: "openrouter",
      model: "a-model",
      estimatedCost: 0,
      reason: "test",
      searchRequired: false,
      searchPolicySource: "explicit",
      visionRequired: false,
      outcome: "SUCCESS",
    },
  ] as never;
}

/** Seed a complete, internally consistent run the way the producers would. */
function seedRun(): string {
  const recorder = new LlmRunRecorder(runIdFor(CLIENT, BUILD));
  const runId = recordCompetitiveLandscapeLeg({
    client_id: CLIENT,
    build_id: BUILD,
    ranking_llm_calls: 0,
  });
  for (const [operation, taskId] of [
    ["SEO_CONTENT_BLUEPRINT", "bp-global"],
    ["SEO_CONTENT_BLUEPRINT", "bp-batch-1"],
    ["STRUCTURED_CONTENT_GENERATION", "gen-home"],
    ["CONTENT_VALIDATION", "val-home"],
  ] as const) {
    recorder.attributeOperationCall({
      operation,
      purpose: `[build-intelligence] ${taskId}`,
      attempt: "initial",
      descriptorRequiresSearch: false,
      decisions: decision(taskId),
    });
  }
  recordSeoContentBlueprintLeg({
    client_id: CLIENT,
    build_id: BUILD,
    evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
    recorder,
  });
  recordStructuredContentLeg({
    client_id: CLIENT,
    build_id: BUILD,
    evidence: {
      route_count: 1,
      generation_llm_calls: 1,
      semantic_validation_llm_calls: 1,
      repair_attempts: 0,
      schema_failure_count: 0,
      repaired_route_ids: [],
      route_results: [
        {
          route_id: "home",
          path: "/",
          generation_calls: 1,
          repair_attempts: 0,
          semantic_validation_calls: 1,
        },
      ],
    },
    recorder,
  });
  recorder.close();
  return runId;
}

let app: FastifyInstance;
beforeEach(async () => {
  _resetRateLimiter();
  _resetRunEvidenceStore();
  app = Fastify({ logger: false });
  registerApiSecurity(app);
  await registerBuildIntelligenceRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("GET /api/build-intelligence/run-evidence", () => {
  it("enforces machine authentication (401 without credentials)", async () => {
    seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence?client_id=${CLIENT}&build_id=${BUILD}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns the run's audit by (client_id, build_id)", async () => {
    const runId = seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence?client_id=${CLIENT}&build_id=${BUILD}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema).toBe(RUN_LLM_AUDIT_SCHEMA);
    expect(body.run_id).toBe(runId);
    expect(res.headers[RUN_ID_HEADER]).toBe(runId);
    // Every field Website-Bot consumes is present and measured.
    expect(body.competitive_landscape.ranking_llm_calls).toBe(0);
    expect(body.seo_content_blueprint.batch_size).toBe(4);
    expect(body.seo_content_blueprint.batch_count).toBe(1);
    expect(body.structured_content.route_results).toEqual([
      {
        route_id: "home",
        path: "/",
        generation_calls: 1,
        repair_attempts: 0,
        semantic_validation_calls: 1,
      },
    ]);
    expect(body.operations.SEO_CONTENT_BLUEPRINT).toHaveLength(2);
    expect(body.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
    expect(body.operations.CONTENT_VALIDATION).toHaveLength(1);
    expect(body.direct_provider_bypass_count).toBe(0);
    expect(body.unsupported_capability_combination_count).toBe(0);
  });

  it("returns the same audit by run_id path", async () => {
    const runId = seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence/${runId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run_id).toBe(runId);
  });

  it("records the applied search policy per governed operation", async () => {
    seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence?client_id=${CLIENT}&build_id=${BUILD}`,
      headers: AUTH,
    });
    const body = res.json();
    for (const operation of [
      "SEO_CONTENT_BLUEPRINT",
      "STRUCTURED_CONTENT_GENERATION",
      "CONTENT_VALIDATION",
    ] as const) {
      expect(body.operations[operation].length).toBeGreaterThan(0);
      for (const call of body.operations[operation]) {
        expect(call.searchRequired).toBe(false);
        expect(call.searchPolicySource).toBe("EXPLICIT");
        expect(call.descriptor_requires_search).toBe(false);
      }
    }
  });

  it("404s an unknown run rather than inventing an empty one", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence/${runIdFor(CLIENT, "never-ran")}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("RUN_EVIDENCE_NOT_FOUND");
  });

  it("400s a producer request whose run identity is blank", async () => {
    // Run identity must be well formed for the run's evidence to be
    // addressable, so a whitespace-only id is a bad request, not a run.
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: AUTH,
      payload: {
        client_id: "   ",
        build_id: BUILD,
        market: { niche: "roofing", country: "United States", language: "English" },
        seed_queries: [{ query: "metal roofing", intent: "commercial" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid run identity");
  });

  it("400s a query missing the run identity", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/build-intelligence/run-evidence?client_id=client-1",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("422s a run whose recorded evidence contradicts itself", async () => {
    // A structured-content leg with no matching router decisions is not a run
    // that can be exported — the read surface reports the violations instead.
    recordStructuredContentLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: {
        route_count: 1,
        generation_llm_calls: 1,
        semantic_validation_llm_calls: 1,
        repair_attempts: 0,
        schema_failure_count: 0,
        repaired_route_ids: [],
        route_results: [
          {
            route_id: "home",
            path: "/",
            generation_calls: 1,
            repair_attempts: 0,
            semantic_validation_calls: 1,
          },
        ],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence?client_id=${CLIENT}&build_id=${BUILD}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("RUN_LLM_AUDIT_INVALID");
    expect(res.json().violations.length).toBeGreaterThan(0);
  });

  it("still rejects provider/model leakage now that run_ref is accepted", async () => {
    for (const leak of [{ provider: "perplexity" }, { model: "gpt-4o" }, { temperature: 0.9 }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/build-intelligence/competitive-landscape",
        headers: AUTH,
        payload: {
          client_id: CLIENT,
          build_id: BUILD,
          run_ref: "wb-run-abc",
          market: { niche: "roofing", country: "United States", language: "English" },
          seed_queries: [{ query: "metal roofing", intent: "commercial" }],
          ...leak,
        },
      });
      expect(res.statusCode, `leak ${JSON.stringify(leak)} must be rejected`).toBe(400);
    }
  });

  it("advertises the audit schema in preflight so the consumer can discover it", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/build-intelligence/preflight",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().capabilities.run_llm_audit).toBe(RUN_LLM_AUDIT_SCHEMA);
  });
});
