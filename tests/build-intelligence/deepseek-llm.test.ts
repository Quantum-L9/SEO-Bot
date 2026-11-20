/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BudgetExhaustedError,
  createDeepSeekBuildIntelligenceLlm,
  DeepSeekTransportError,
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

type DeepSeekOptions = NonNullable<Parameters<typeof createDeepSeekBuildIntelligenceLlm>[0]>;
type DeepSeekLlm = ReturnType<typeof createDeepSeekBuildIntelligenceLlm>;

function okTransport() {
  return vi
    .fn()
    .mockImplementation(() => Promise.resolve(jsonResponse(JSON.stringify({ ok: true }))));
}

function deepSeekClient(model: string | undefined, options: Omit<DeepSeekOptions, "env">) {
  return createDeepSeekBuildIntelligenceLlm({
    env: { DEEPSEEK_API_KEY: "test-key", ...(model ? { DEEPSEEK_MODEL: model } : {}) },
    ...options,
  });
}

function validateCall(llm: DeepSeekLlm, id: string, schemaRepairAttempts: 0 | 1 = 0) {
  return llm.executePolicyJson("CONTENT_VALIDATION", {
    clientId: `client-${id}`,
    buildId: `build-${id}`,
    module: "test",
    purpose: "validate",
    systemPrompt: "json",
    userPrompt: "route",
    validate: (parsed) => parsed as { ok: boolean },
    schemaRepairAttempts,
  });
}

async function withLedgerDir(run: (ledgerDir: string) => Promise<void>): Promise<void> {
  const ledgerDir = mkdtempSync(join(tmpdir(), "deepseek-spend-"));
  try {
    await run(ledgerDir);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
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
    expect(String(init?.body)).toContain("deepseek-v4-pro");
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
        model: "deepseek-v4-pro",
        outcome: "SUCCESS",
      }),
    ]);
  });

  it("does not repair a transport failure or an HTTP error", async () => {
    const aborted = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(
      validateCall(deepSeekClient(undefined, { transport: aborted }), "timeout", 1),
    ).rejects.toBeInstanceOf(DeepSeekTransportError);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(aborted.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const http = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
    await expect(
      validateCall(deepSeekClient(undefined, { transport: http }), "http", 1),
    ).rejects.toBeInstanceOf(DeepSeekTransportError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("uses a transport error name structured-content treats as terminal", () => {
    const source = readFileSync("src/build-intelligence/structured-content.ts", "utf8");
    expect(source).toContain('"DeepSeekTransportError"');
    const error = new DeepSeekTransportError("down");
    expect(error.name).toBe("DeepSeekTransportError");
    expect(error).toBeInstanceOf(ProviderRequestError);
  });

  it("does not dispatch once the configured spend ceiling is exhausted", async () => {
    resetDeepSeekSpendForTests();
    const transport = okTransport();
    const llm = deepSeekClient("deepseek-flash", {
      transport,
      ceilings: { monthlyUsd: 0.0062, weeklyUsd: 100, globalMonthlyUsd: 2000 },
    });
    await validateCall(llm, "budget");
    await validateCall(llm, "budget");
    await expect(validateCall(llm, "budget")).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("treats a zero daily cap as disabled and rolls weekly spend into the next week", async () => {
    await withLedgerDir(async (ledgerDir) => {
      let now = new Date("2026-01-26T12:00:00.000Z");
      const transport = okTransport();
      const llm = deepSeekClient("deepseek-flash", {
        transport,
        ledgerDir,
        now: () => now,
        ceilings: { monthlyUsd: 10, weeklyUsd: 0.0031, globalMonthlyUsd: 2000, dailyUsd: 0 },
      });
      await validateCall(llm, "week");
      await expect(validateCall(llm, "week")).rejects.toBeInstanceOf(BudgetExhaustedError);
      now = new Date("2026-02-02T12:00:00.000Z");
      await validateCall(llm, "week");
      expect(transport).toHaveBeenCalledTimes(2);
    });
  });

  it("rolls monthly spend into the next month inside the same week", async () => {
    await withLedgerDir(async (ledgerDir) => {
      let now = new Date("2026-01-31T12:00:00.000Z");
      const transport = okTransport();
      const llm = deepSeekClient("deepseek-flash", {
        transport,
        ledgerDir,
        now: () => now,
        ceilings: { monthlyUsd: 0.0031, weeklyUsd: 10, globalMonthlyUsd: 2000 },
      });
      await validateCall(llm, "month");
      await expect(validateCall(llm, "month")).rejects.toBeInstanceOf(BudgetExhaustedError);
      now = new Date("2026-02-01T12:00:00.000Z");
      await validateCall(llm, "month");
      expect(transport).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the open period after a new client is constructed", async () => {
    await withLedgerDir(async (ledgerDir) => {
      const now = () => new Date("2026-03-04T12:00:00.000Z");
      const ceilings = { monthlyUsd: 0.0031, weeklyUsd: 10, globalMonthlyUsd: 2000 };
      const first = deepSeekClient("deepseek-flash", {
        transport: okTransport(),
        ledgerDir,
        now,
        ceilings,
      });
      await validateCall(first, "restart");
      const secondTransport = vi.fn();
      const second = deepSeekClient("deepseek-flash", {
        transport: secondTransport,
        ledgerDir,
        now,
        ceilings,
      });
      await expect(validateCall(second, "restart")).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect(secondTransport).not.toHaveBeenCalled();
    });
  });
});
