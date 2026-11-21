/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BuildIntelligenceOperation,
  batchFromPurpose,
  createDeepSeekBuildIntelligenceLlm,
  DEEPSEEK_PROVIDER_POLICIES,
  DeepSeekOutputTruncatedError,
  TaskValidationError,
} from "../../src/build-intelligence/deepseek-llm.js";
import {
  assertProviderAttempts,
  PROVIDER_ATTEMPTS_SCHEMA,
  ProviderAttemptsInvalidError,
} from "../../src/build-intelligence/provider-attempts.js";
import {
  _resetRunEvidenceStore,
  getRunProviderAttempts,
  recordProviderAttempts,
} from "../../src/build-intelligence/run-evidence-store.js";
import { runIdFor } from "../../src/build-intelligence/run-llm-audit.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

function reply(content: string, finishReason: string, usage?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const USAGE = { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 };

let ledgerDir: string;
beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), "provider-policy-"));
  _resetRunEvidenceStore();
});
afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
});

function client(transport: (url: string, init: RequestInit) => Promise<Response>) {
  return createDeepSeekBuildIntelligenceLlm({
    env: { DEEPSEEK_API_KEY: "test-key" },
    transport,
    ledgerDir,
  });
}

function call(
  llm: ReturnType<typeof client>,
  operation: BuildIntelligenceOperation,
  recorder: LlmRunRecorder,
  purpose = "seo-content-blueprint:batch-1:build",
) {
  return llm.executePolicyJson(operation, {
    clientId: "client",
    buildId: "build",
    module: "test",
    purpose,
    systemPrompt: "json",
    userPrompt: "input",
    validate: (value) => value,
    recorder,
  });
}

describe("DeepSeek per-operation provider policy", () => {
  it("states thinking disabled and json_object explicitly on every JSON operation's request body", async () => {
    for (const operation of Object.keys(
      DEEPSEEK_PROVIDER_POLICIES,
    ) as BuildIntelligenceOperation[]) {
      const transport = vi
        .fn()
        .mockImplementation(() => Promise.resolve(reply('{"ok":true}', "stop", USAGE)));
      await call(client(transport), operation, new LlmRunRecorder(`run-${operation}`));
      const body = JSON.parse(String((transport.mock.calls[0] as [string, RequestInit])[1].body));
      expect(body.thinking, operation).toEqual({ type: "disabled" });
      expect(body.response_format, operation).toEqual({ type: "json_object" });
      // Thinking is selected by `thinking` alone; no effort is sent that could
      // re-enable it.
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  });

  it("refuses an operation that has no typed policy before any dispatch", async () => {
    const transport = vi.fn();
    const llm = client(transport);
    await expect(
      llm.executePolicyJson("UNKNOWN_OPERATION" as BuildIntelligenceOperation, {
        clientId: "c",
        module: "t",
        purpose: "p",
        systemPrompt: "s",
        userPrompt: "u",
        validate: (value) => value,
      }),
    ).rejects.toBeInstanceOf(TaskValidationError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("names batches from producer purposes", () => {
    expect(batchFromPurpose("seo-content-blueprint:batch-12:b")).toBe("batch-12");
    expect(batchFromPurpose("seo-content-blueprint:global-intent:b")).toBe("global-intent");
    expect(batchFromPurpose("structured-content:/about")).toBeNull();
  });
});

describe("DeepSeek attempt receipts", () => {
  it("records a truncated attempt with reasoning tokens and raises the typed truncation, never repairing", async () => {
    const recorder = new LlmRunRecorder("run-trunc");
    const transport = vi.fn().mockImplementation(() =>
      Promise.resolve(
        reply('{"routes":[', "length", {
          prompt_tokens: 5_000,
          completion_tokens: 4_000,
          total_tokens: 9_000,
          completion_tokens_details: { reasoning_tokens: 3_950 },
        }),
      ),
    );
    const error = await call(client(transport), "SEO_CONTENT_BLUEPRINT", recorder).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DeepSeekOutputTruncatedError);
    expect(error).toMatchObject({
      code: "LLM_OUTPUT_TRUNCATED",
      reasoningTokens: 3_950,
      promptTokens: 5_000,
      site: { batch: "batch-1", operation: "SEO_CONTENT_BLUEPRINT" },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [receipt] = recorder.providerAttemptReceipts();
    expect(receipt).toMatchObject({
      outcome: "OUTPUT_TRUNCATED",
      finish_reason: "length",
      max_tokens: 5_000,
      prompt_tokens: 5_000,
      completion_tokens: 4_000,
      reasoning_tokens: 3_950,
      policy: "structured-json/thinking-disabled@1",
    });
    // Priced from usage at the peak table: 5000 in, 4000 out on deepseek-v4-pro.
    expect(receipt?.cost_usd).toBeCloseTo((5_000 * 1.32 + 4_000 * 3.96) / 1_000_000, 12);
  });

  it("records missing usage as null tokens and null cost, never zero", async () => {
    const recorder = new LlmRunRecorder("run-nousage");
    const transport = vi
      .fn()
      .mockImplementation(() => Promise.resolve(reply('{"ok":true}', "stop")));
    await call(client(transport), "CONTENT_VALIDATION", recorder);
    expect(recorder.providerAttemptReceipts()[0]).toMatchObject({
      outcome: "OK",
      prompt_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
      cost_usd: null,
    });
  });

  it("records the initial schema failure and the repair as two receipts", async () => {
    const recorder = new LlmRunRecorder("run-repair");
    const transport = vi
      .fn()
      .mockResolvedValueOnce(reply("not json", "stop", USAGE))
      .mockResolvedValueOnce(reply('{"ok":true}', "stop", USAGE));
    await call(client(transport), "CONTENT_VALIDATION", recorder);
    expect(
      recorder.providerAttemptReceipts().map((receipt) => [receipt.attempt, receipt.outcome]),
    ).toEqual([
      ["initial", "SCHEMA_INVALID"],
      ["repair", "OK"],
    ]);
  });
});

describe("provider attempts spend invariant", () => {
  it("run-evidence spend equals the sum of the attempt receipts, across legs and failures", async () => {
    const first = new LlmRunRecorder("leg-1");
    const second = new LlmRunRecorder("leg-2");
    const ok = vi
      .fn()
      .mockImplementation(() => Promise.resolve(reply('{"ok":true}', "stop", USAGE)));
    await call(client(ok), "SEO_CONTENT_BLUEPRINT", first);
    await call(client(ok), "SEO_CONTENT_BLUEPRINT", first);
    const broken = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await call(client(broken), "STRUCTURED_CONTENT_GENERATION", second).catch(() => undefined);

    recordProviderAttempts({ client_id: "c", build_id: "b", recorder: first });
    // Recording the same recorder twice must not double-count spend.
    recordProviderAttempts({ client_id: "c", build_id: "b", recorder: first });
    recordProviderAttempts({
      client_id: "c",
      build_id: "b",
      recorder: second,
      failure: {
        leg: "structured_content",
        code: "DEEPSEEK_TRANSPORT_ERROR",
        operation: "STRUCTURED_CONTENT_GENERATION",
        batch: null,
      },
    });

    const doc = getRunProviderAttempts(runIdFor("c", "b"));
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(doc.schema).toBe(PROVIDER_ATTEMPTS_SCHEMA);
    expect(doc.attempt_count).toBe(3);
    const priced = [...first.providerAttemptReceipts(), ...second.providerAttemptReceipts()];
    const expected = priced.reduce((sum, receipt) => sum + (receipt.cost_usd ?? 0), 0);
    expect(doc.spend_usd).toBe(expected);
    expect(doc.spend_usd).toBeCloseTo(2 * ((1_000 * 1.32 + 100 * 3.96) / 1_000_000), 12);
    expect(doc.unpriced_attempt_count).toBe(1);
    expect(doc.leg_failures).toHaveLength(1);
  });

  it("rejects a document whose spend does not equal its receipts", () => {
    const receipt = {
      attempt_id: "a1",
      operation: "SEO_CONTENT_BLUEPRINT",
      purpose: "p",
      batch: null,
      attempt: "initial" as const,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      policy: "structured-json/thinking-disabled@1",
      max_tokens: 100,
      dispatched: true,
      finish_reason: "stop",
      prompt_tokens: 10,
      completion_tokens: 10,
      reasoning_tokens: null,
      cost_usd: 0.5,
      pricing_basis: "deepseek-peak-per-mtok",
      outcome: "OK" as const,
    };
    const document = {
      schema: PROVIDER_ATTEMPTS_SCHEMA,
      run_id: "r",
      client_id: "c",
      build_id: "b",
      produced_at: new Date().toISOString(),
      attempt_count: 1,
      attempts: [receipt],
      spend_usd: 0.25,
      unpriced_attempt_count: 0,
      leg_failures: [],
    };
    expect(() => assertProviderAttempts(document)).toThrow(ProviderAttemptsInvalidError);
    expect(() => assertProviderAttempts({ ...document, spend_usd: 0.5 })).not.toThrow();
    expect(() =>
      assertProviderAttempts({
        ...document,
        spend_usd: 0,
        attempts: [{ ...receipt, dispatched: false, cost_usd: 0 }],
      }),
    ).toThrow(ProviderAttemptsInvalidError);
  });
});
