/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * GAP-005 — LlmService routing, budget governance, and memory hydration.
 *
 * The repo tests `llm-parse` helpers but never `LlmService` itself. That leaves
 * the budget config wiring, the daily-cap gate ordering, memory-context
 * injection, usage recording, and the per-method task-type mapping unproven —
 * any of which could regress silently. These tests mock the router and assert
 * the service's contract with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── @quantum-l9/llm-router mock: capture constructor config + execute calls ────
const routerCtor = vi.hoisted(() => ({ calls: [] as any[] }));
const executeMock = vi.hoisted(() => vi.fn());
const initClientMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@quantum-l9/llm-router", () => {
  class BudgetExhaustedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "BudgetExhaustedError";
    }
  }
  const TaskType = {
    CLASSIFICATION: "classification",
    EXTRACTION: "extraction",
    SCORING: "scoring",
    CONTENT_GENERATION: "content_generation",
    STRATEGIC_REASONING: "strategic_reasoning",
    COMPETITOR_RESEARCH: "competitor_research",
    CITATION_CHECK: "citation_check",
    LAYOUT_VALIDATION: "layout_validation",
  } as const;
  const TaskComplexity = {
    TRIVIAL: "trivial",
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
  } as const;
  class L9LLMRouter {
    constructor(config: unknown) {
      routerCtor.calls.push(config);
    }
    execute = executeMock;
    planVisualQA() {
      return [];
    }
    initClient = initClientMock;
    getCallLog() {
      return [];
    }
  }
  return { L9LLMRouter, TaskType, TaskComplexity, BudgetExhaustedError };
});

// Config the service reads for budget + daily-cap.
const config = vi.hoisted(() => ({
  current: {
    DEFAULT_CLIENT_MONTHLY_BUDGET: 100,
    DEFAULT_CLIENT_WEEKLY_TARGET: 25,
    DEFAULT_CLIENT_WEEKLY_CEILING: 40,
    GLOBAL_MONTHLY_HARD_CEILING: 5000,
    SURGE_THRESHOLD: 0.9,
    PERPLEXITY_API_KEY: "pplx-key",
    OPENROUTER_API_KEY: "or-key",
    DAILY_SPEND_CAP: 0, // disabled by default; individual tests raise it.
  } as Record<string, unknown>,
}));
vi.mock("../../src/core/config.js", () => ({ getConfig: () => config.current }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// DB: insert(llmUsage).values(...) for logUsage; select(...) for getDailySpend.
const usageValuesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const dailyTotal = vi.hoisted(() => ({ value: 0 }));
vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({
    insert: () => ({ values: usageValuesMock }),
    select: () => ({
      from: () => ({ where: () => Promise.resolve([{ totalCost: dailyTotal.value }]) }),
    }),
  }),
  schema: { llmUsage: { cost: "llmUsage.cost", timestamp: "llmUsage.timestamp" } },
}));

// Memory hydration returns a recognizable marker appended to the system prompt.
const hydrateMock = vi.hoisted(() => vi.fn().mockResolvedValue("\n\n[MEMORY-CONTEXT]"));
vi.mock("../../src/services/memory.js", () => ({ hydrateSeoContext: hydrateMock }));

// Parsers are pure; stub to decouple task-type tests from response formatting.
vi.mock("../../src/services/llm-parse.js", () => ({
  parseJsonFromLlm: vi.fn(() => ({ ok: true })),
  parseScore: vi.fn(() => 50),
}));

import { BudgetExhaustedError, TaskComplexity, TaskType } from "@quantum-l9/llm-router";
import { DailyBudgetExhaustedError, LlmService } from "../../src/services/llm.js";

const okResponse = {
  content: "ok",
  inputTokens: 10,
  outputTokens: 20,
  cost: 0.01,
  model: "test-model",
};

beforeEach(() => {
  routerCtor.calls.length = 0;
  executeMock.mockReset();
  executeMock.mockResolvedValue(okResponse);
  usageValuesMock.mockClear();
  hydrateMock.mockClear();
  hydrateMock.mockResolvedValue("\n\n[MEMORY-CONTEXT]");
  dailyTotal.value = 0;
  config.current.DAILY_SPEND_CAP = 0;
});

describe("LlmService constructor — budget + router wiring (GAP-005)", () => {
  it("builds the router with the exact app name, credentials, and budget config", () => {
    new LlmService();
    expect(routerCtor.calls).toHaveLength(1);
    expect(routerCtor.calls[0]).toEqual({
      perplexityApiKey: "pplx-key",
      openrouterApiKey: "or-key",
      appName: "L9-SEO-Bot",
      budget: {
        monthlyBudgetPerClient: 100,
        weeklyTarget: 25,
        weeklyHardCeiling: 40,
        globalMonthlyHardCeiling: 5000,
        surgeThreshold: 0.9,
      },
    });
  });
});

describe("LlmService.execute — gate ordering + memory + usage (GAP-005)", () => {
  it("requires a clientId before any provider or memory work", async () => {
    const svc = new LlmService();
    await expect(
      svc.execute(
        { type: TaskType.CLASSIFICATION, complexity: TaskComplexity.LOW } as any,
        "sys",
        "user",
      ),
    ).rejects.toThrow("clientId is required");
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("initializes an unregistered client before dispatch so build-time calls work", async () => {
    const svc = new LlmService();
    await svc.execute(
      { clientId: "safehavenrr", type: TaskType.SCORING, complexity: TaskComplexity.LOW } as any,
      "sys",
      "user",
    );
    expect(initClientMock).toHaveBeenCalledWith("safehavenrr", undefined);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the daily cap BEFORE hydrating memory or calling the provider", async () => {
    config.current.DAILY_SPEND_CAP = 5;
    dailyTotal.value = 6; // already over cap
    const svc = new LlmService();

    await expect(
      svc.execute(
        { clientId: "c1", type: TaskType.SCORING, complexity: TaskComplexity.LOW } as any,
        "sys",
        "user",
      ),
    ).rejects.toBeInstanceOf(DailyBudgetExhaustedError);

    expect(hydrateMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(usageValuesMock).not.toHaveBeenCalled();
  });

  it("appends the hydrated memory context to the system prompt and forwards options", async () => {
    const svc = new LlmService();
    const images = ["https://img/1.png"];
    await svc.execute(
      {
        clientId: "c1",
        type: TaskType.CONTENT_GENERATION,
        complexity: TaskComplexity.MEDIUM,
        description: "[web-vitals] fix",
      } as any,
      "SYSTEM",
      "USER",
      { images },
    );

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [task, systemPrompt, userPrompt, options] = executeMock.mock.calls[0];
    expect(systemPrompt).toBe("SYSTEM\n\n[MEMORY-CONTEXT]");
    expect(userPrompt).toBe("USER");
    expect(options).toEqual({ images });
    expect(task.clientId).toBe("c1");
  });

  it("records usage on a successful call (module parsed from the description tag)", async () => {
    const svc = new LlmService();
    await svc.execute(
      {
        clientId: "c1",
        type: TaskType.EXTRACTION,
        complexity: TaskComplexity.LOW,
        description: "[serp-intelligence] parse",
      } as any,
      "sys",
      "user",
    );
    expect(usageValuesMock).toHaveBeenCalledTimes(1);
    expect(usageValuesMock.mock.calls[0][0]).toMatchObject({
      clientId: "c1",
      module: "serp-intelligence",
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.01,
    });
  });

  it("does NOT record usage when the provider call fails", async () => {
    executeMock.mockRejectedValueOnce(new Error("provider down"));
    const svc = new LlmService();
    await expect(
      svc.execute(
        { clientId: "c1", type: TaskType.SCORING, complexity: TaskComplexity.LOW } as any,
        "sys",
        "user",
      ),
    ).rejects.toThrow("provider down");
    expect(usageValuesMock).not.toHaveBeenCalled();
  });

  it("propagates BudgetExhaustedError with its distinct type (not a generic Error)", async () => {
    executeMock.mockRejectedValueOnce(
      new BudgetExhaustedError(
        "weekly ceiling hit",
        { clientId: "c1", type: TaskType.SCORING, complexity: TaskComplexity.LOW },
        {} as never,
        {} as never,
      ),
    );
    const svc = new LlmService();
    await expect(
      svc.execute(
        { clientId: "c1", type: TaskType.SCORING, complexity: TaskComplexity.LOW } as any,
        "sys",
        "user",
      ),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(usageValuesMock).not.toHaveBeenCalled();
  });
});

describe("LlmService public methods route the correct task type + complexity (GAP-005)", () => {
  it("classify → CLASSIFICATION / LOW", async () => {
    await new LlmService().classify("prompt", "c1", "web-vitals" as any, "purpose");
    expect(executeMock.mock.calls[0][0]).toMatchObject({
      type: TaskType.CLASSIFICATION,
      complexity: TaskComplexity.LOW,
    });
  });

  it("score → SCORING / LOW", async () => {
    await new LlmService().score("prompt", "c1", "web-vitals" as any, "purpose");
    expect(executeMock.mock.calls[0][0]).toMatchObject({
      type: TaskType.SCORING,
      complexity: TaskComplexity.LOW,
    });
  });

  it("extractJson → EXTRACTION", async () => {
    await new LlmService().extractJson("prompt", "c1", "web-vitals" as any, "purpose");
    expect(executeMock.mock.calls[0][0]).toMatchObject({ type: TaskType.EXTRACTION });
  });

  it("generateContent → CONTENT_GENERATION", async () => {
    await new LlmService().generateContent("sys", "user", "c1", "web-vitals" as any, "purpose");
    expect(executeMock.mock.calls[0][0]).toMatchObject({ type: TaskType.CONTENT_GENERATION });
  });

  it("strategize → STRATEGIC_REASONING / HIGH with reasoning required", async () => {
    await new LlmService().strategize("sys", "user", "c1", "web-vitals" as any, "purpose");
    expect(executeMock.mock.calls[0][0]).toMatchObject({
      type: TaskType.STRATEGIC_REASONING,
      complexity: TaskComplexity.HIGH,
      requiresReasoning: true,
    });
  });
});

describe("LlmService.executePolicyJson — schemaRepairAttempts + actual-call counting", () => {
  const baseArgs = (validate: (v: unknown) => unknown, extra: Record<string, unknown> = {}) => ({
    clientId: "c1",
    module: "build-intelligence" as any,
    purpose: "policy-json-test",
    systemPrompt: "sys",
    userPrompt: "user",
    validate,
    ...extra,
  });

  it("defaults to one bounded repair when the validator rejects the first parse", async () => {
    const svc = new LlmService();
    const validate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("bad json");
      })
      .mockImplementationOnce((value: unknown) => value);
    const result = await svc.executePolicyJson<unknown>(
      "STRUCTURED_CONTENT_GENERATION",
      baseArgs(validate),
    );
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it("propagates the second failure terminally — no further retry", async () => {
    const svc = new LlmService();
    const validate = vi.fn().mockImplementation(() => {
      throw new Error("still bad");
    });
    await expect(
      svc.executePolicyJson("STRUCTURED_CONTENT_GENERATION", baseArgs(validate)),
    ).rejects.toThrow("still bad");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("schemaRepairAttempts: 0 hands the repair to the caller — one call, error propagates", async () => {
    const svc = new LlmService();
    const validate = vi.fn().mockImplementation(() => {
      throw new Error("rejected");
    });
    await expect(
      svc.executePolicyJson(
        "STRUCTURED_CONTENT_GENERATION",
        baseArgs(validate, { schemaRepairAttempts: 0 }),
      ),
    ).rejects.toThrow("rejected");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects any schemaRepairAttempts value other than 0 or 1 before spending a call", async () => {
    const svc = new LlmService();
    await expect(
      svc.executePolicyJson(
        "STRUCTURED_CONTENT_GENERATION",
        baseArgs(vi.fn(), { schemaRepairAttempts: 2 as any }),
      ),
    ).rejects.toThrow("schemaRepairAttempts must be 0 or 1");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("callCounter increments once per ACTUAL call — twice when the bounded repair runs", async () => {
    const svc = new LlmService();
    const counter = { value: 0 };
    const validate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("bad");
      })
      .mockImplementationOnce((value: unknown) => value);
    await svc.executePolicyJson(
      "STRUCTURED_CONTENT_GENERATION",
      baseArgs(validate, { callCounter: counter }),
    );
    expect(counter.value).toBe(2);
  });

  it("callCounter increments exactly once with schemaRepairAttempts: 0, even on failure", async () => {
    const svc = new LlmService();
    const counter = { value: 0 };
    const validate = vi.fn().mockImplementation(() => {
      throw new Error("bad");
    });
    await expect(
      svc.executePolicyJson(
        "STRUCTURED_CONTENT_GENERATION",
        baseArgs(validate, { schemaRepairAttempts: 0, callCounter: counter }),
      ),
    ).rejects.toThrow("bad");
    expect(counter.value).toBe(1);
  });
});
