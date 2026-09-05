/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The measurement layer, exercised against the REAL @quantum-l9/llm-router with
 * stub provider clients — no paid call, but real route resolution, so the
 * search policy the recorder reports is the policy the router actually applied.
 */

import { L9LLMRouter, TaskComplexity, TaskType } from "@quantum-l9/llm-router";
import { describe, expect, it } from "vitest";
import {
  type SeoImproveLlmOperation,
  seoImproveTask,
} from "../../src/services/improve-llm-policy.js";
import {
  _openRecorderCount,
  canonicalSearchPolicySource,
  LlmRunRecorder,
  publishCapabilityRejection,
  publishDirectProviderBypass,
} from "../../src/services/llm-run-recorder.js";

/**
 * Provider stubs at the router's own client seam. Route resolution, capability
 * validation, budgeting, and the call log are all REAL; only the network hop is
 * replaced, so no paid call is ever made.
 */
function stubResponse(provider: string, model: string) {
  return {
    content: "{}",
    model,
    provider,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cost: 0,
    latencyMs: 1,
    cached: false,
  };
}

function stubOpenRouter() {
  const respond = async () => stubResponse("openrouter", OPENROUTER_STUB_MODEL);
  return { complete: respond, completeWithVision: respond, completeWithFallback: respond };
}

function stubPerplexity() {
  const respond = async () => stubResponse("perplexity", "sonar-stub");
  return { complete: respond, completeWithConsensus: respond };
}

const OPENROUTER_STUB_MODEL = "openrouter-stub";

async function router(clientId = "client-1"): Promise<L9LLMRouter> {
  const instance = newRouter();
  // The real service initialises the budget account before executing; do the
  // same so route resolution and dispatch run their real paths.
  await instance.initClient(clientId);
  return instance;
}

function newRouter(): L9LLMRouter {
  return new L9LLMRouter(
    { perplexityApiKey: "pplx-test-key", openrouterApiKey: "sk-or-test-key" },
    {
      // Both planes are stubbed so route resolution is real while dispatch is free.
      perplexityClient: stubPerplexity() as never,
      openrouterClient: stubOpenRouter() as never,
    },
  );
}

/**
 * Drive one governed operation through the real router the way
 * `LlmService.executeGoverned` does, and attribute it from the router's own log.
 */
async function runGoverned(
  instance: L9LLMRouter,
  recorder: LlmRunRecorder,
  operation: SeoImproveLlmOperation,
  clientId = "client-1",
): Promise<void> {
  const task = seoImproveTask(operation, clientId, `[build-intelligence] ${operation}`);
  const response = await instance.execute(task, "system", "user");
  recorder.attributeOperationCall({
    operation,
    purpose: `[build-intelligence] ${operation}`,
    attempt: "initial",
    descriptorRequiresSearch: typeof task.requiresSearch === "boolean" ? task.requiresSearch : null,
    decisions: instance.getCallLogByClient(clientId, 50),
    response: { provider: String(response.provider) },
  });
}

describe("LlmRunRecorder — governed policy evidence comes from the router", () => {
  it("records the search policy the ROUTER applied, not the policy SEO-Bot intended", async () => {
    const instance = await router();
    const recorder = new LlmRunRecorder("seo-run:test");
    await runGoverned(instance, recorder, "SEO_CONTENT_BLUEPRINT");
    await runGoverned(instance, recorder, "STRUCTURED_CONTENT_GENERATION");
    await runGoverned(instance, recorder, "CONTENT_VALIDATION");
    recorder.close();

    const snapshot = recorder.snapshot();
    expect(snapshot.operations).toHaveLength(3);
    expect(snapshot.attribution_failures).toEqual([]);
    for (const entry of snapshot.operations) {
      // The governed policy supplies requiresSearch:false for all three ops, so
      // the router must report EXPLICIT — and the recorder must carry the value
      // that was actually supplied so EXPLICIT can be checked, not trusted.
      expect(entry.searchRequired).toBe(false);
      // Recorded as the enum NAME the governed-run oracle requires, mapped
      // from the router's lowercase enum value rather than upper-cased blindly.
      expect(entry.searchPolicySource).toBe("EXPLICIT");
      expect(entry.descriptor_requires_search).toBe(false);
      expect(entry.outcome).toBe("SUCCESS");
      expect(entry.task_id).toBeTruthy();
      expect(entry.model).toBeTruthy();
    }
  });

  it("reports TASK_DEFAULT with no supplied policy when the caller declares none", async () => {
    const instance = await router();
    const recorder = new LlmRunRecorder("seo-run:test");
    // A descriptor with NO requiresSearch — the legacy task-type default path.
    const response = await instance.execute(
      {
        clientId: "client-1",
        type: TaskType.CONTENT_GENERATION,
        complexity: TaskComplexity.LOW,
        description: "[build-intelligence] ungoverned",
      },
      "system",
      "user",
    );
    recorder.attributeOperationCall({
      operation: "STRUCTURED_CONTENT_GENERATION",
      purpose: "[build-intelligence] ungoverned",
      attempt: "initial",
      descriptorRequiresSearch: null,
      decisions: instance.getCallLogByClient("client-1", 50),
      response: { provider: String(response.provider) },
    });
    recorder.close();

    const entry = recorder.snapshot().operations[0]!;
    expect(entry.searchPolicySource).toBe("TASK_DEFAULT");
    expect(entry.descriptor_requires_search).toBeNull();
  });

  it("counts each ACTUAL call separately, including a bounded repair", async () => {
    const instance = await router();
    const recorder = new LlmRunRecorder("seo-run:test");
    await runGoverned(instance, recorder, "STRUCTURED_CONTENT_GENERATION");
    await runGoverned(instance, recorder, "STRUCTURED_CONTENT_GENERATION");
    recorder.close();

    const calls = recorder.operationsFor("STRUCTURED_CONTENT_GENERATION");
    expect(calls).toHaveLength(2);
    // Distinct router-assigned ids: two executions, never one counted twice.
    expect(new Set(calls.map((call) => call.task_id)).size).toBe(2);
  });
});

describe("LlmRunRecorder — unattributable evidence is never guessed", () => {
  it("records an attribution failure when no new router decision appeared", () => {
    const recorder = new LlmRunRecorder("seo-run:test");
    recorder.attributeOperationCall({
      operation: "CONTENT_VALIDATION",
      purpose: "[build-intelligence] content-validation:home",
      attempt: "initial",
      descriptorRequiresSearch: false,
      decisions: [],
    });
    recorder.close();
    const failures = recorder.snapshot().attribution_failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/observed 0/);
    expect(recorder.snapshot().operations).toEqual([]);
  });

  it("records an attribution failure when the answering plane is not the routed plane", async () => {
    const instance = await router();
    const recorder = new LlmRunRecorder("seo-run:test");
    const task = seoImproveTask("CONTENT_VALIDATION", "client-1", "[build-intelligence] v");
    await instance.execute(task, "system", "user");
    recorder.attributeOperationCall({
      operation: "CONTENT_VALIDATION",
      purpose: "[build-intelligence] v",
      attempt: "initial",
      descriptorRequiresSearch: false,
      decisions: instance.getCallLogByClient("client-1", 50),
      response: { provider: "perplexity" },
    });
    recorder.close();
    expect(recorder.snapshot().attribution_failures[0]!.reason).toMatch(
      /but the call was answered by perplexity/,
    );
  });

  it("does not let a later call re-claim a decision an earlier one already used", async () => {
    const instance = await router();
    const recorder = new LlmRunRecorder("seo-run:test");
    await runGoverned(instance, recorder, "CONTENT_VALIDATION");
    // Same log replayed with no new call: nothing fresh is left to claim.
    recorder.attributeOperationCall({
      operation: "CONTENT_VALIDATION",
      purpose: "[build-intelligence] replay",
      attempt: "repair",
      descriptorRequiresSearch: false,
      decisions: instance.getCallLogByClient("client-1", 50),
    });
    recorder.close();
    expect(recorder.snapshot().operations).toHaveLength(1);
    expect(recorder.snapshot().attribution_failures).toHaveLength(1);
  });
});

describe("LlmRunRecorder — run-scoped event subscription", () => {
  it("counts only events that actually occurred while the run was open", () => {
    const before = _openRecorderCount();
    const recorder = new LlmRunRecorder("seo-run:test");
    expect(_openRecorderCount()).toBe(before + 1);

    expect(recorder.snapshot().direct_provider_bypasses).toEqual([]);
    expect(recorder.snapshot().capability_rejections).toEqual([]);

    publishDirectProviderBypass({
      site: "aeo-geo:answer-engine-observation",
      engine: "perplexity",
      rationale: "the engine is the measurement subject",
    });
    publishCapabilityRejection({
      code: "UNSUPPORTED_CAPABILITY_COMBINATION",
      task_type: "layout_validation",
      operation: null,
      message: "no provider serves search and vision together",
    });
    expect(recorder.snapshot().direct_provider_bypasses).toHaveLength(1);
    expect(recorder.snapshot().capability_rejections).toHaveLength(1);

    recorder.close();
    expect(_openRecorderCount()).toBe(before);

    // Events after close belong to a different run, not this one.
    publishDirectProviderBypass({
      site: "aeo-geo:answer-engine-observation",
      engine: "perplexity",
      rationale: "later run",
    });
    expect(recorder.snapshot().direct_provider_bypasses).toHaveLength(1);
  });

  it("close() is idempotent", () => {
    const before = _openRecorderCount();
    const recorder = new LlmRunRecorder("seo-run:test");
    recorder.close();
    recorder.close();
    expect(_openRecorderCount()).toBe(before);
  });
});

/**
 * The router reports lowercase enum VALUES; the audit records the enum NAME,
 * which is the spelling the governed-run oracle requires downstream. Mapping
 * by name keeps the translation total — an unrecognised value must survive
 * verbatim so the audit schema rejects it, rather than being upper-cased into
 * something that merely looks canonical.
 */
describe("canonicalSearchPolicySource", () => {
  it("maps the router's enum values to their names", () => {
    expect(canonicalSearchPolicySource("explicit")).toBe("EXPLICIT");
    expect(canonicalSearchPolicySource("task_default")).toBe("TASK_DEFAULT");
  });

  it("is idempotent on an already-canonical name", () => {
    expect(canonicalSearchPolicySource("EXPLICIT")).toBe("EXPLICIT");
    expect(canonicalSearchPolicySource("TASK_DEFAULT")).toBe("TASK_DEFAULT");
  });

  it("passes an unknown value through instead of inventing a canonical one", () => {
    // Blind upper-casing would turn this into a plausible-looking "INFERRED";
    // passing it through lets the audit schema reject it.
    expect(canonicalSearchPolicySource("inferred")).toBe("inferred");
    expect(canonicalSearchPolicySource(undefined)).toBe("undefined");
  });
});
