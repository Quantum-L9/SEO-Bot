/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Deterministic replay of the Quantum AI Partners (QAP) 5-route blueprint run
 * through the REAL DeepSeek build-intelligence client with a recorded/fake
 * transport — no network, no paid call. Every request body is captured, so a
 * bounded repair would be visible as an extra HTTP call.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_PARTY_AUTHORITY_SCHEMA } from "@quantum-l9/bot-interop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekBuildIntelligenceLlm } from "../../src/build-intelligence/deepseek-llm.js";
import {
  createSEOContentBlueprintWithEvidence,
  SEO_BLUEPRINT_BATCH_SIZE,
} from "../../src/build-intelligence/seo-content-blueprint.js";
import {
  seoBlueprintBatchOutputTokens,
  seoBlueprintGlobalIntentOutputTokens,
} from "../../src/services/seo-blueprint-output-budget.js";
import { answerBlueprintPrompt } from "./fixtures/contract-following-model.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const QAP_ROUTES = [
  { route_id: "home", path: "/", purpose: "primary landing" },
  { route_id: "crm-transformation", path: "/crm-transformation", purpose: "service" },
  { route_id: "revops", path: "/revops", purpose: "service" },
  { route_id: "how-it-works", path: "/how-it-works", purpose: "process" },
  { route_id: "contact", path: "/contact", purpose: "conversion" },
];

interface RecordedRequest {
  max_tokens: number;
  response_format: unknown;
  userPrompt: string;
}

describe("QAP 5-route blueprint — recorded transport, no live calls", () => {
  let ledgerDir: string;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "qap-blueprint-spend-"));
  });
  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("batches 4+1, sizes each batch from the output budget, parses every reply without repair, covers all 5 routes", async () => {
    const requests: RecordedRequest[] = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(init.body)) as {
        max_tokens: number;
        response_format: unknown;
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = body.messages.find((m) => m.role === "user")?.content ?? "";
      requests.push({
        max_tokens: body.max_tokens,
        response_format: body.response_format,
        userPrompt,
      });
      const content = JSON.stringify(answerBlueprintPrompt(userPrompt));
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { completion_tokens: Math.ceil(content.length / 4) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
      ledgerDir,
    });

    const { artifact, evidence } = await createSEOContentBlueprintWithEvidence(
      {
        client_id: "quantum-ai-partners",
        build_id: "qap-replay",
        first_party_authority: {
          schema: FIRST_PARTY_AUTHORITY_SCHEMA,
          market_research: "not_requested",
          domain_spec_digest: "cd".repeat(32),
          donor_count: 0,
        },
        routes: QAP_ROUTES,
        business_facts: [],
      },
      { llm },
    );

    // Batching: BATCH_SIZE 4 → batches of 4 and 1.
    expect(SEO_BLUEPRINT_BATCH_SIZE).toBe(4);
    const tasks = requests.map((r) => (JSON.parse(r.userPrompt) as { task: string }).task);
    expect(tasks).toEqual([
      "global_route_intent_plan",
      "seo_content_blueprint_batch",
      "seo_content_blueprint_batch",
    ]);
    const batchIds = requests
      .slice(1)
      .map((r) =>
        (
          JSON.parse(r.userPrompt) as { current_batch: Array<{ route_id: string }> }
        ).current_batch.map((route) => route.route_id),
      );
    expect(batchIds).toEqual([
      ["home", "crm-transformation", "revops", "how-it-works"],
      ["contact"],
    ]);
    expect(evidence).toEqual({
      route_count: 5,
      batch_size: 4,
      batch_count: 2,
      completed_batches: 2,
    });

    // Per-call max_tokens comes from the output budget module.
    expect(requests.map((r) => r.max_tokens)).toEqual([
      seoBlueprintGlobalIntentOutputTokens(5),
      seoBlueprintBatchOutputTokens(4),
      seoBlueprintBatchOutputTokens(1),
    ]);
    expect(requests.map((r) => r.max_tokens)).toEqual([5_000, 14_500, 4_000]);
    for (const request of requests) {
      expect(request.response_format).toEqual({ type: "json_object" });
    }

    // No repair: exactly one HTTP call per operation, and no repair prompt.
    expect(transport).toHaveBeenCalledTimes(3);
    for (const request of requests) {
      expect(request.userPrompt).not.toContain("Your previous response was rejected");
    }

    // The assembled blueprint covers all 5 routes in requested order.
    expect(artifact.payload.routes.map((r) => [r.route_id, r.path])).toEqual(
      QAP_ROUTES.map((r) => [r.route_id, r.path]),
    );
    expect(artifact.payload.batch_count).toBe(2);
  });
});
