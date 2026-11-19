/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it, vi } from "vitest";
import { createDeepSeekBuildIntelligenceLlm } from "../../src/build-intelligence/deepseek-llm.js";
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
});
