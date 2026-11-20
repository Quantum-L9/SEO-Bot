/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it, vi } from "vitest";
import {
  BudgetExhaustedError,
  createDeepSeekBuildIntelligenceLlm,
  ProviderRequestError,
  resetDeepSeekSpendForTests,
} from "../../src/build-intelligence/deepseek-llm.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

function jsonResponse(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
      usage: { completion_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("build-intelligence DeepSeek client", () => {
  it("posts to DeepSeek and repairs invalid JSON once", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("not json"))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ ok: true })));
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
    });
    const value = await llm.executePolicyJson("CONTENT_VALIDATION", {
      clientId: "client",
      module: "test",
      purpose: "validate",
      systemPrompt: "json",
      userPrompt: "route",
      validate: (parsed) => parsed as { ok: boolean },
      schemaRepairAttempts: 1,
    });
    expect(value).toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
    const [url, init] = transport.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(String(init?.headers && (init.headers as Record<string, string>).Authorization)).toBe(
      "Bearer test-key",
    );
    expect(String(init?.body)).toContain("deepseek-flash");
  });

  it("does not repair a truncated reply", async () => {
    const transport = vi.fn().mockResolvedValue(jsonResponse("{}", "length"));
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
    });
    await expect(
      llm.strategizeJson({
        clientId: "client",
        module: "test",
        purpose: "blueprint",
        systemPrompt: "json",
        userPrompt: "routes",
        validate: (parsed) => parsed,
        schemaRepairAttempts: 1,
      }),
    ).rejects.toThrow(/truncat/i);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("records the call as a direct DeepSeek decision", async () => {
    const transport = vi.fn().mockResolvedValue(jsonResponse(JSON.stringify({ ok: true })));
    const recorder = new LlmRunRecorder("deepseek-test");
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
    });
    await llm.executePolicyJson("CONTENT_VALIDATION", {
      clientId: "client",
      module: "test",
      purpose: "validate",
      systemPrompt: "json",
      userPrompt: "route",
      validate: (parsed) => parsed as { ok: boolean },
      schemaRepairAttempts: 0,
      recorder,
    });
    const snapshot = recorder.snapshot();
    recorder.close();
    expect(snapshot.attribution_failures).toEqual([]);
    expect(snapshot.operations).toEqual([
      expect.objectContaining({
        operation: "CONTENT_VALIDATION",
        provider: "deepseek",
        model: "deepseek-flash",
        outcome: "SUCCESS",
      }),
    ]);
  });

  it("does not repair a transport failure or an HTTP error", async () => {
    const aborted = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport: aborted,
    });
    await expect(
      llm.executePolicyJson("CONTENT_VALIDATION", {
        clientId: "client-timeout",
        buildId: "build-timeout",
        module: "test",
        purpose: "validate",
        systemPrompt: "json",
        userPrompt: "route",
        validate: (parsed) => parsed,
        schemaRepairAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(aborted.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const http = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
    const failing = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport: http,
    });
    await expect(
      failing.executePolicyJson("CONTENT_VALIDATION", {
        clientId: "client-http",
        buildId: "build-http",
        module: "test",
        purpose: "validate",
        systemPrompt: "json",
        userPrompt: "route",
        validate: (parsed) => parsed,
        schemaRepairAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch once the configured spend ceiling is exhausted", async () => {
    resetDeepSeekSpendForTests();
    const transport = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(JSON.stringify({ ok: true }))));
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
      ceilings: { monthlyUsd: 0.0062, weeklyUsd: 100, globalMonthlyUsd: 2000 },
    });
    const call = () =>
      llm.executePolicyJson("CONTENT_VALIDATION", {
        clientId: "client-budget",
        buildId: "build-budget",
        module: "test",
        purpose: "validate",
        systemPrompt: "json",
        userPrompt: "route",
        validate: (parsed) => parsed as { ok: boolean },
        schemaRepairAttempts: 0,
      });
    await call();
    await call();
    await expect(call()).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
