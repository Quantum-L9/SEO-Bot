/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * The blueprint producer is replaced by a scenario that drives the REAL
 * DeepSeek client through a recorded/fake transport, so the provider failure
 * reaching the API is the one the client actually raises. No network call.
 */
const scenario = vi.hoisted(() => ({
  run: null as null | ((deps: { recorder?: unknown }) => Promise<never>),
}));

vi.mock("../../src/build-intelligence/seo-content-blueprint.js", () => {
  class SeoContentBlueprintBatchInvalidError extends Error {
    readonly code = "SEO_CONTENT_BLUEPRINT_BATCH_INVALID";
  }
  return {
    createSEOContentBlueprintWithEvidence: vi.fn(
      async (_request: unknown, deps: { recorder?: unknown }) => {
        if (!scenario.run) throw new Error("no scenario");
        return scenario.run(deps);
      },
    ),
    CompetitiveLandscapeInputInvalidError: class extends Error {},
    CompetitiveLandscapeRefMismatchError: class extends Error {},
    RouteSetMismatchError: class extends Error {},
    SeoContentBlueprintInvalidError: class extends Error {},
    SeoContentBlueprintBatchInvalidError,
  };
});

import { FIRST_PARTY_AUTHORITY_SCHEMA } from "@quantum-l9/bot-interop";
import { registerBuildIntelligenceRoutes } from "../../src/api/build-intelligence.js";
import { _resetRateLimiter, registerApiSecurity } from "../../src/api/security.js";
import { createDeepSeekBuildIntelligenceLlm } from "../../src/build-intelligence/deepseek-llm.js";
import { _resetRunEvidenceStore } from "../../src/build-intelligence/run-evidence-store.js";
import { runIdFor } from "../../src/build-intelligence/run-llm-audit.js";
import * as blueprint from "../../src/build-intelligence/seo-content-blueprint.js";
import type { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

const AUTH = { authorization: "Bearer machine-key" };
const CLIENT = "client-qap";
const BUILD = "build-qap-1";

/** Recorded shape of a DeepSeek reply that spent its budget on reasoning. */
function deepSeekReply(content: string, finishReason: string, usage: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      id: "recorded",
      object: "chat.completion",
      model: "deepseek-v4-pro",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const TRUNCATED_USAGE = {
  prompt_tokens: 6_000,
  completion_tokens: 4_000,
  total_tokens: 10_000,
  completion_tokens_details: { reasoning_tokens: 3_900 },
  prompt_tokens_details: { cached_tokens: 0 },
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 6_000,
};

const OK_USAGE = {
  prompt_tokens: 1_000,
  completion_tokens: 200,
  total_tokens: 1_200,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 1_000,
};

let ledgerDir: string;
let app: FastifyInstance;

function llmWith(
  transport: (url: string, init: RequestInit) => Promise<Response>,
  ceilings?: { monthlyUsd: number; weeklyUsd: number; globalMonthlyUsd: number },
) {
  return createDeepSeekBuildIntelligenceLlm({
    env: { DEEPSEEK_API_KEY: "test-key" },
    transport,
    ledgerDir,
    ...(ceilings ? { ceilings } : {}),
  });
}

function blueprintCall(
  llm: ReturnType<typeof llmWith>,
  recorder: unknown,
  purpose: string,
  validate: (value: unknown) => unknown = (value) => value,
) {
  return llm.strategizeJson({
    clientId: CLIENT,
    buildId: BUILD,
    module: "build-intelligence",
    purpose,
    systemPrompt: "json",
    userPrompt: "routes",
    expectedOutputTokens: 4_000,
    validate,
    recorder: recorder as LlmRunRecorder,
  });
}

async function postBlueprint() {
  return app.inject({
    method: "POST",
    url: "/api/build-intelligence/seo-content-blueprint",
    headers: AUTH,
    payload: {
      client_id: CLIENT,
      build_id: BUILD,
      first_party_authority: {
        schema: FIRST_PARTY_AUTHORITY_SCHEMA,
        market_research: "not_requested",
        domain_spec_digest: "a".repeat(64),
        donor_count: 0,
      },
      routes: [{ route_id: "/", path: "/", purpose: "Home" }],
      business_facts: [],
    },
  });
}

async function attempts() {
  return app.inject({
    method: "GET",
    url: `/api/build-intelligence/run-evidence/${runIdFor(CLIENT, BUILD)}/provider-attempts`,
    headers: AUTH,
  });
}

beforeEach(async () => {
  ledgerDir = mkdtempSync(join(tmpdir(), "bi-provider-failures-"));
  _resetRateLimiter();
  _resetRunEvidenceStore();
  vi.mocked(blueprint.createSEOContentBlueprintWithEvidence).mockClear();
  app = Fastify({ logger: false });
  registerApiSecurity(app);
  await registerBuildIntelligenceRoutes(app);
  await app.ready();
});

afterEach(async () => {
  scenario.run = null;
  await app.close();
  rmSync(ledgerDir, { recursive: true, force: true });
});

describe("build-intelligence — typed provider failures (no generic 500)", () => {
  it("answers a truncated batch with LLM_OUTPUT_TRUNCATED, operation, batch and token measurements, and records the failed leg", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(deepSeekReply("[]", "stop", OK_USAGE))
      .mockResolvedValueOnce(deepSeekReply('{"routes":[{"route_id"', "length", TRUNCATED_USAGE));
    scenario.run = async ({ recorder }) => {
      const llm = llmWith(transport);
      await blueprintCall(llm, recorder, `seo-content-blueprint:global-intent:${BUILD}`);
      await blueprintCall(llm, recorder, `seo-content-blueprint:batch-2:${BUILD}`);
      throw new Error("unreachable");
    };

    const res = await postBlueprint();
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body).toMatchObject({
      error: "LLM_OUTPUT_TRUNCATED",
      operation: "SEO_CONTENT_BLUEPRINT",
      batch: "batch-2",
      attempt: "initial",
      policy: "structured-json/thinking-disabled@1",
      finish_reason: "length",
      max_tokens: 4_000,
      completion_tokens: 4_000,
      prompt_tokens: 6_000,
      reasoning_tokens: 3_900,
    });
    // Truncation is never repaired: two calls, not three.
    expect(transport).toHaveBeenCalledTimes(2);

    const evidence = await attempts();
    expect(evidence.statusCode).toBe(200);
    const doc = evidence.json();
    expect(doc.attempt_count).toBe(2);
    expect(doc.attempts.map((a: { outcome: string }) => a.outcome)).toEqual([
      "OK",
      "OUTPUT_TRUNCATED",
    ]);
    expect(doc.attempts[1]).toMatchObject({
      batch: "batch-2",
      finish_reason: "length",
      max_tokens: 4_000,
      reasoning_tokens: 3_900,
      dispatched: true,
    });
    expect(doc.leg_failures).toEqual([
      {
        leg: "seo_content_blueprint",
        code: "LLM_OUTPUT_TRUNCATED",
        operation: "SEO_CONTENT_BLUEPRINT",
        batch: "batch-2",
      },
    ]);
    const sum = doc.attempts.reduce(
      (total: number, a: { cost_usd: number | null }) => total + (a.cost_usd ?? 0),
      0,
    );
    expect(doc.spend_usd).toBeCloseTo(sum, 12);
    expect(doc.spend_usd).toBeGreaterThan(0);
  });

  it("maps a spend-cap refusal to 402 SPEND_CAP_REFUSED with the operation and batch", async () => {
    const transport = vi.fn();
    scenario.run = async ({ recorder }) => {
      const llm = llmWith(transport, {
        monthlyUsd: 0.000001,
        weeklyUsd: 100,
        globalMonthlyUsd: 100,
      });
      await blueprintCall(llm, recorder, `seo-content-blueprint:global-intent:${BUILD}`);
      throw new Error("unreachable");
    };
    const res = await postBlueprint();
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({
      error: "SPEND_CAP_REFUSED",
      operation: "SEO_CONTENT_BLUEPRINT",
      batch: "global-intent",
    });
    expect(transport).not.toHaveBeenCalled();
    const doc = (await attempts()).json();
    expect(doc.attempts).toHaveLength(1);
    expect(doc.attempts[0]).toMatchObject({
      outcome: "SPEND_CAP_REFUSED",
      dispatched: false,
      cost_usd: 0,
    });
    expect(doc.spend_usd).toBe(0);
  });

  it("maps a transport failure to 502 DEEPSEEK_TRANSPORT_ERROR and records an unpriced attempt", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("upstream down", { status: 503 }));
    scenario.run = async ({ recorder }) => {
      await blueprintCall(llmWith(transport), recorder, `seo-content-blueprint:batch-1:${BUILD}`);
      throw new Error("unreachable");
    };
    const res = await postBlueprint();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "DEEPSEEK_TRANSPORT_ERROR", batch: "batch-1" });
    const doc = (await attempts()).json();
    expect(doc.attempts[0]).toMatchObject({ outcome: "TRANSPORT_ERROR", cost_usd: null });
    expect(doc.unpriced_attempt_count).toBe(1);
    expect(doc.spend_usd).toBe(0);
  });

  it("maps a batch that failed its bounded repair to 422 SEO_CONTENT_BLUEPRINT_BATCH_INVALID with its batch", async () => {
    const transport = vi
      .fn()
      .mockImplementation(() => Promise.resolve(deepSeekReply('{"routes":{}}', "stop", OK_USAGE)));
    scenario.run = async ({ recorder }) => {
      try {
        await blueprintCall(
          llmWith(transport),
          recorder,
          `seo-content-blueprint:batch-3:${BUILD}`,
          () => {
            throw new Error("routes must be an array");
          },
        );
      } catch (error) {
        throw new blueprint.SeoContentBlueprintBatchInvalidError(
          `Batch 3 failed validation after its bounded repair: ${(error as Error).message}`,
        );
      }
      throw new Error("unreachable");
    };
    const res = await postBlueprint();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "SEO_CONTENT_BLUEPRINT_BATCH_INVALID",
      operation: "SEO_CONTENT_BLUEPRINT",
      batch: "batch-3",
      attempt: "repair",
    });
    const doc = (await attempts()).json();
    expect(
      doc.attempts.map((a: { attempt: string; outcome: string }) => [a.attempt, a.outcome]),
    ).toEqual([
      ["initial", "SCHEMA_INVALID"],
      ["repair", "SCHEMA_INVALID"],
    ]);
  });

  it("maps a schema failure after the bounded repair to 422 LLM_SCHEMA_INVALID_AFTER_REPAIR, not 500", async () => {
    const transport = vi
      .fn()
      .mockImplementation(() => Promise.resolve(deepSeekReply("{}", "stop", OK_USAGE)));
    scenario.run = async ({ recorder }) => {
      await blueprintCall(
        llmWith(transport),
        recorder,
        `seo-content-blueprint:global-intent:${BUILD}`,
        () => {
          throw new Error("expected array, received object");
        },
      );
      throw new Error("unreachable");
    };
    const res = await postBlueprint();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "LLM_SCHEMA_INVALID_AFTER_REPAIR",
      operation: "SEO_CONTENT_BLUEPRINT",
      batch: "global-intent",
      attempt: "repair",
    });
  });
});

describe("build-intelligence — a failed run is traceable from its response body", () => {
  it("carries run_id in the typed failure body, and provider-attempts resolves by that id and by client/build", async () => {
    const transport = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(deepSeekReply('{"routes":[{"route_id"', "length", TRUNCATED_USAGE)),
      );
    scenario.run = async ({ recorder }) => {
      await blueprintCall(llmWith(transport), recorder, `seo-content-blueprint:batch-1:${BUILD}`);
      throw new Error("unreachable");
    };
    const res = await postBlueprint();
    expect(res.statusCode).toBe(502);
    const body = res.json();
    const runId = runIdFor(CLIENT, BUILD);
    // The run id is in the BODY, not only the header: a caller that keeps only
    // bodies (Website-Bot's build evidence) can still find the attempts.
    expect(body.run_id).toBe(runId);
    expect(body.provider_attempts).toBe(
      `/api/build-intelligence/run-evidence/${encodeURIComponent(runId)}/provider-attempts`,
    );

    const byId = await app.inject({ method: "GET", url: body.provider_attempts, headers: AUTH });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({
      run_id: runId,
      attempt_count: 1,
      leg_failures: [{ leg: "seo_content_blueprint", code: "LLM_OUTPUT_TRUNCATED" }],
    });

    // A caller holding only the build id (the canary8 404) can resolve it too.
    const byBuild = await app.inject({
      method: "GET",
      url: `/api/build-intelligence/run-evidence/provider-attempts?client_id=${CLIENT}&build_id=${BUILD}`,
      headers: AUTH,
    });
    expect(byBuild.statusCode).toBe(200);
    expect(byBuild.json()).toEqual(byId.json());
  });

  it("answers an unknown run with 404, never a fabricated document", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/build-intelligence/run-evidence/provider-attempts?client_id=nobody&build_id=none",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("RUN_EVIDENCE_NOT_FOUND");
  });
});
