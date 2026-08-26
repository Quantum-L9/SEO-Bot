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
// The router's own decision log — what run evidence reads back rather than
// restating SEO-Bot's intent. Tests append to it as `execute` is called.
const callLog = vi.hoisted(() => ({ entries: [] as any[] }));

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
      return callLog.entries;
    }
    getCallLogByClient(clientId: string) {
      return callLog.entries.filter((entry: any) => entry.clientId === clientId);
    }
  }
  class UnsupportedCapabilityCombinationError extends Error {
    code: string;
    constructor(
      message: string,
      _requested?: unknown,
      code = "UNSUPPORTED_CAPABILITY_COMBINATION",
    ) {
      super(message);
      this.name = "UnsupportedCapabilityCombinationError";
      this.code = code;
    }
  }
  const SearchPolicySource = { EXPLICIT: "explicit", TASK_DEFAULT: "task_default" } as const;
  return {
    L9LLMRouter,
    TaskType,
    TaskComplexity,
    BudgetExhaustedError,
    SearchPolicySource,
    UnsupportedCapabilityCombinationError,
  };
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

import {
  BudgetExhaustedError,
  TaskComplexity,
  TaskType,
  UnsupportedCapabilityCombinationError,
} from "@quantum-l9/llm-router";
import { DailyBudgetExhaustedError, LlmService } from "../../src/services/llm.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

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
  callLog.entries.length = 0;
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

/**
 * Run evidence is taken at THIS layer because this is where a provider/model
 * execution actually happens. Two properties are proved here: each ACTUAL call
 * yields exactly one recorded execution carrying the router's own applied
 * search policy, and a capability combination the router refuses is counted
 * even though it never reaches the router's call log.
 */
describe("LlmService — run evidence is measured at the router boundary", () => {
  const baseArgs = (validate: (v: unknown) => unknown, extra: Record<string, unknown> = {}) => ({
    clientId: "c1",
    module: "build-intelligence" as any,
    purpose: "policy-json-test",
    systemPrompt: "sys",
    userPrompt: "user",
    validate,
    ...extra,
  });

  /** Make `execute` append a router decision the way the real router does. */
  function logDecisionsPerCall(overrides: Record<string, unknown> = {}): void {
    let index = 0;
    executeMock.mockImplementation(async () => {
      index += 1;
      callLog.entries.push({
        taskId: `task-${index}`,
        clientId: "c1",
        timestamp: "2026-08-21T00:00:00.000Z",
        taskType: "content_generation",
        complexity: "high",
        provider: "openrouter",
        model: "routed-model",
        estimatedCost: 0,
        reason: "test",
        searchRequired: false,
        searchPolicySource: "explicit",
        visionRequired: false,
        outcome: "SUCCESS",
        ...overrides,
      });
      return { ...okResponse, provider: "openrouter" };
    });
  }

  it("records one execution per ACTUAL call, with the policy the ROUTER applied", async () => {
    logDecisionsPerCall();
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    await svc.executePolicyJson<unknown>(
      "STRUCTURED_CONTENT_GENERATION",
      baseArgs((value) => value, { recorder }),
    );
    recorder.close();

    const calls = recorder.operationsFor("STRUCTURED_CONTENT_GENERATION");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      attempt: "initial",
      task_id: "task-1",
      provider: "openrouter",
      model: "routed-model",
      searchRequired: false,
      searchPolicySource: "EXPLICIT",
      // The governed policy supplies requiresSearch:false, so EXPLICIT is
      // provable rather than merely reported.
      descriptor_requires_search: false,
      outcome: "SUCCESS",
    });
    expect(recorder.snapshot().attribution_failures).toEqual([]);
  });

  it("records the bounded repair as its own execution, not as part of the first", async () => {
    logDecisionsPerCall();
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    const validate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("bad");
      })
      .mockImplementationOnce((value: unknown) => value);
    await svc.executePolicyJson<unknown>("CONTENT_VALIDATION", baseArgs(validate, { recorder }));
    recorder.close();

    const calls = recorder.operationsFor("CONTENT_VALIDATION");
    expect(calls.map((call) => call.attempt)).toEqual(["initial", "repair"]);
    expect(new Set(calls.map((call) => call.task_id)).size).toBe(2);
  });

  it("records SEO_CONTENT_BLUEPRINT executions made through strategizeJson", async () => {
    logDecisionsPerCall({ taskType: "strategic_reasoning" });
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    await svc.strategizeJson<unknown>({
      clientId: "c1",
      module: "build-intelligence" as any,
      purpose: "seo-content-blueprint:global-intent",
      systemPrompt: "sys",
      userPrompt: "user",
      validate: (value) => value,
      recorder,
    });
    recorder.close();
    expect(recorder.operationsFor("SEO_CONTENT_BLUEPRINT")).toHaveLength(1);
  });

  it("records nothing when no recorder is supplied (evidence is opt-in, not ambient)", async () => {
    logDecisionsPerCall();
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:other");
    await svc.executePolicyJson<unknown>(
      "STRUCTURED_CONTENT_GENERATION",
      baseArgs((value) => value),
    );
    recorder.close();
    expect(recorder.snapshot().operations).toEqual([]);
  });

  it("counts a refused capability combination that never reaches the call log", async () => {
    executeMock.mockRejectedValue(
      new UnsupportedCapabilityCombinationError("no provider serves search and vision together"),
    );
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    await expect(
      svc.executePolicyJson<unknown>(
        "STRUCTURED_CONTENT_GENERATION",
        baseArgs((value) => value, { recorder }),
      ),
    ).rejects.toThrow("no provider serves search and vision together");
    recorder.close();

    const rejections = recorder.snapshot().capability_rejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY_COMBINATION",
      operation: "STRUCTURED_CONTENT_GENERATION",
    });
    // The refusal produced no router decision, so nothing is attributed.
    expect(recorder.snapshot().operations).toEqual([]);
  });

  it("carries the router's specific conflict code rather than a generic one", async () => {
    executeMock.mockRejectedValue(
      new UnsupportedCapabilityCombinationError(
        "search modifiers require search capability",
        undefined,
        "SEARCH_MODIFIER_WITHOUT_SEARCH",
      ),
    );
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    await expect(
      svc.execute(
        {
          clientId: "c1",
          type: TaskType.CONTENT_GENERATION,
          complexity: TaskComplexity.LOW,
          description: "[build-intelligence] modifier",
        },
        "sys",
        "user",
      ),
    ).rejects.toThrow("search modifiers require search capability");
    recorder.close();
    expect(recorder.snapshot().capability_rejections[0]).toMatchObject({
      code: "SEARCH_MODIFIER_WITHOUT_SEARCH",
      operation: null,
    });
  });

  it("does not count an ordinary provider failure as a capability rejection", async () => {
    executeMock.mockRejectedValue(
      new BudgetExhaustedError(
        "out of budget",
        { clientId: "c1", type: TaskType.SCORING, complexity: TaskComplexity.LOW },
        {} as never,
        {} as never,
      ),
    );
    const svc = new LlmService();
    const recorder = new LlmRunRecorder("seo-run:test");
    await expect(
      svc.executePolicyJson<unknown>(
        "CONTENT_VALIDATION",
        baseArgs((value) => value, { recorder }),
      ),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    recorder.close();
    expect(recorder.snapshot().capability_rejections).toEqual([]);
  });
});
