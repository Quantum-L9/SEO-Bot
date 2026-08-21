/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The run-evidence store assembles one `l9.seo-bot-run-llm-audit/v1` document
 * from the three build-intelligence legs, keyed by a run id both producer and
 * consumer derive from (client_id, build_id). Assembly is fail-closed: a run
 * whose legs contradict each other surfaces as a validation failure, never as a
 * plausible-looking audit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetRunEvidenceStore,
  getRunLlmAudit,
  getRunLlmAuditFor,
  recordCompetitiveLandscapeLeg,
  recordSeoContentBlueprintLeg,
  recordStructuredContentLeg,
} from "../../src/build-intelligence/run-evidence-store.js";
import {
  RUN_LLM_AUDIT_SCHEMA,
  RunLlmAuditInvalidError,
  runIdFor,
} from "../../src/build-intelligence/run-llm-audit.js";
import type { StructuredContentEvidence } from "../../src/build-intelligence/structured-content.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

const CLIENT = "client-1";
const BUILD = "build-1";

/** A recorder pre-loaded with N successful calls for one governed operation. */
function recorderWith(
  entries: Array<{ operation: string; taskId: string; attempt?: "initial" | "repair" }>,
): LlmRunRecorder {
  const recorder = new LlmRunRecorder(runIdFor(CLIENT, BUILD));
  for (const entry of entries) {
    recorder.attributeOperationCall({
      operation: entry.operation,
      purpose: `[build-intelligence] ${entry.taskId}`,
      attempt: entry.attempt ?? "initial",
      descriptorRequiresSearch: false,
      decisions: [
        {
          taskId: entry.taskId,
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
      ] as never,
    });
  }
  return recorder;
}

function contentEvidence(
  routeResults: StructuredContentEvidence["route_results"],
): StructuredContentEvidence {
  return {
    route_count: routeResults.length,
    generation_llm_calls: routeResults.reduce((sum, route) => sum + route.generation_calls, 0),
    semantic_validation_llm_calls: routeResults.reduce(
      (sum, route) => sum + route.semantic_validation_calls,
      0,
    ),
    repair_attempts: routeResults.filter((route) => route.repair_attempts > 0).length,
    schema_failure_count: 0,
    repaired_route_ids: routeResults
      .filter((route) => route.repair_attempts > 0)
      .map((route) => route.route_id),
    route_results: routeResults,
  };
}

beforeEach(() => {
  _resetRunEvidenceStore();
});

describe("run-evidence store — one run across three endpoints", () => {
  it("returns null for a run it has never seen", () => {
    expect(getRunLlmAudit("seo-run:unknown")).toBeNull();
    expect(getRunLlmAuditFor(CLIENT, BUILD)).toBeNull();
  });

  it("merges the three legs into one audit under a deterministic run id", () => {
    const runId = recordCompetitiveLandscapeLeg({
      client_id: CLIENT,
      build_id: BUILD,
      ranking_llm_calls: 0,
    });
    expect(runId).toBe(runIdFor(CLIENT, BUILD));

    const blueprintRecorder = recorderWith([
      { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-global" },
      { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-batch-1" },
    ]);
    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
      recorder: blueprintRecorder,
    });
    blueprintRecorder.close();

    const contentRecorder = recorderWith([
      { operation: "STRUCTURED_CONTENT_GENERATION", taskId: "gen-home" },
      { operation: "STRUCTURED_CONTENT_GENERATION", taskId: "gen-services" },
      {
        operation: "STRUCTURED_CONTENT_GENERATION",
        taskId: "gen-services-repair",
        attempt: "repair",
      },
      { operation: "CONTENT_VALIDATION", taskId: "val-home" },
    ]);
    recordStructuredContentLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: contentEvidence([
        {
          route_id: "home",
          path: "/",
          generation_calls: 1,
          repair_attempts: 0,
          semantic_validation_calls: 1,
        },
        {
          route_id: "services",
          path: "/services",
          generation_calls: 2,
          repair_attempts: 1,
          semantic_validation_calls: 2,
        },
      ]),
      recorder: contentRecorder,
    });
    contentRecorder.close();

    const audit = getRunLlmAudit(runId);
    expect(audit).not.toBeNull();
    expect(audit?.schema).toBe(RUN_LLM_AUDIT_SCHEMA);
    expect(audit?.run_id).toBe(runId);
    expect(audit?.competitive_landscape.ranking_llm_calls).toBe(0);
    expect(audit?.seo_content_blueprint.batch_size).toBe(4);
    expect(audit?.seo_content_blueprint.batch_count).toBe(1);
    expect(audit?.structured_content.route_results.map((route) => route.path)).toEqual([
      "/",
      "/services",
    ]);
    // The per-route counters and the router-attributed calls agree: 1 + 2 === 3.
    expect(audit?.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(3);
    expect(audit?.operations.SEO_CONTENT_BLUEPRINT).toHaveLength(2);
    expect(audit?.operations.CONTENT_VALIDATION).toHaveLength(1);
    expect(audit?.legs).toEqual({
      competitive_landscape: true,
      seo_content_blueprint: true,
      structured_content: true,
    });
  });

  it("counts a bypass that actually happened, and does not invent one that did not", () => {
    const recorder = new LlmRunRecorder(runIdFor(CLIENT, BUILD));
    recorder.recordDirectProviderBypass({
      site: "aeo-geo:answer-engine-observation",
      engine: "perplexity",
      rationale: "the engine is the measurement subject",
    });
    recorder.recordCapabilityRejection({
      code: "VISION_INPUT_REQUIRED",
      task_type: "layout_validation",
      operation: null,
      message: "visual task requires at least one image",
    });
    recordCompetitiveLandscapeLeg({
      client_id: CLIENT,
      build_id: BUILD,
      ranking_llm_calls: 0,
      recorder,
    });
    recorder.close();

    const audit = getRunLlmAuditFor(CLIENT, BUILD);
    expect(audit?.direct_provider_bypass_count).toBe(1);
    expect(audit?.direct_provider_bypasses[0]?.engine).toBe("perplexity");
    expect(audit?.unsupported_capability_combination_count).toBe(1);
    expect(audit?.unsupported_capability_combinations[0]?.code).toBe("VISION_INPUT_REQUIRED");
  });

  it("keeps a run's counters at zero only because nothing was observed", () => {
    recordCompetitiveLandscapeLeg({ client_id: CLIENT, build_id: BUILD, ranking_llm_calls: 0 });
    const audit = getRunLlmAuditFor(CLIENT, BUILD);
    expect(audit?.direct_provider_bypasses).toEqual([]);
    expect(audit?.direct_provider_bypass_count).toBe(0);
    expect(audit?.unsupported_capability_combinations).toEqual([]);
    expect(audit?.unsupported_capability_combination_count).toBe(0);
    // Legs that never ran are reported as such, not as empty successes.
    expect(audit?.legs.structured_content).toBe(false);
    expect(audit?.structured_content.route_results).toEqual([]);
  });

  it("never double-counts a router decision two legs both observed", () => {
    const shared = { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-global" } as const;
    const first = recorderWith([shared, { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-b1" }]);
    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
      recorder: first,
    });
    first.close();
    // A second recorder that saw the same two decisions must not duplicate them.
    const second = recorderWith([shared, { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-b1" }]);
    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
      recorder: second,
    });
    second.close();

    expect(getRunLlmAuditFor(CLIENT, BUILD)?.operations.SEO_CONTENT_BLUEPRINT).toHaveLength(2);
  });

  it("separates runs that differ only by build_id", () => {
    recordCompetitiveLandscapeLeg({ client_id: CLIENT, build_id: BUILD, ranking_llm_calls: 0 });
    expect(getRunLlmAuditFor(CLIENT, "build-2")).toBeNull();
    expect(getRunLlmAuditFor(CLIENT, BUILD)).not.toBeNull();
  });

  it("fails closed when a leg's evidence contradicts the run", () => {
    // A structured-content leg whose per-route counters have no matching
    // router decisions cannot be exported as a valid audit.
    recordStructuredContentLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: contentEvidence([
        {
          route_id: "home",
          path: "/",
          generation_calls: 1,
          repair_attempts: 0,
          semantic_validation_calls: 1,
        },
      ]),
    });
    expect(() => getRunLlmAuditFor(CLIENT, BUILD)).toThrow(RunLlmAuditInvalidError);
  });
});

/**
 * The consumer contract, pinned.
 *
 * Website-Bot correlates this audit against its own record of the same run and
 * reads three SEO-Bot-owned facts out of it. Those field names and spellings
 * are a cross-repository contract that no test in Website-Bot can protect from
 * this side, so they are asserted here literally rather than through the
 * exported types — a rename that type-checks would still break the consumer.
 */
describe("run-evidence store — cross-repository consumer contract", () => {
  function seedRun(runRef?: string) {
    const recorder = recorderWith([
      { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-g" },
      { operation: "SEO_CONTENT_BLUEPRINT", taskId: "bp-1" },
      { operation: "STRUCTURED_CONTENT_GENERATION", taskId: "gen-home" },
      { operation: "CONTENT_VALIDATION", taskId: "val-home" },
    ]);
    recordCompetitiveLandscapeLeg({
      client_id: CLIENT,
      build_id: BUILD,
      ranking_llm_calls: 0,
      run_ref: runRef,
    });
    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      run_ref: runRef,
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
      recorder,
    });
    recordStructuredContentLeg({
      client_id: CLIENT,
      build_id: BUILD,
      run_ref: runRef,
      evidence: contentEvidence([
        {
          route_id: "home",
          path: "/",
          generation_calls: 1,
          repair_attempts: 0,
          semantic_validation_calls: 1,
        },
      ]),
      recorder,
    });
    recorder.close();
  }

  it("exports the three SEO-Bot-owned facts under the exact paths the consumer reads", () => {
    seedRun();
    const audit = getRunLlmAuditFor(CLIENT, BUILD) as unknown as Record<string, any>;
    // Website-Bot reads these three, and refuses to default any of them.
    expect(audit.competitive_landscape.ranking_llm_calls).toBe(0);
    expect(audit.seo_content_blueprint.batch_size).toBe(4);
    expect(audit.seo_content_blueprint.batch_count).toBe(1);
    expect(audit.structured_content.route_results[0]).toMatchObject({
      route_id: "home",
      path: "/",
      generation_calls: 1,
      repair_attempts: 0,
    });
  });

  it("spells the governed policy fields the way the sealed oracle requires", () => {
    seedRun();
    const audit = getRunLlmAuditFor(CLIENT, BUILD) as unknown as Record<string, any>;
    for (const operation of [
      "SEO_CONTENT_BLUEPRINT",
      "STRUCTURED_CONTENT_GENERATION",
      "CONTENT_VALIDATION",
    ]) {
      expect(audit.operations[operation].length).toBeGreaterThan(0);
      for (const call of audit.operations[operation]) {
        // camelCase key, uppercase enum NAME — not the router's lowercase value.
        expect(call).toHaveProperty("searchRequired", false);
        expect(call).toHaveProperty("searchPolicySource", "EXPLICIT");
        expect(call).not.toHaveProperty("search_required");
        expect(call).not.toHaveProperty("search_policy_source");
      }
    }
  });

  it("echoes the consumer's run id while keeping its own derived id", () => {
    seedRun("wb-run-123");
    const audit = getRunLlmAuditFor(CLIENT, BUILD);
    expect(audit?.run_id).toBe("wb-run-123");
    expect(audit?.seo_run_id).toBe(runIdFor(CLIENT, BUILD));
    expect(audit?.run_id_source).toBe("consumer_supplied");
  });

  it("falls back to the derived id when no consumer ref is supplied", () => {
    seedRun();
    const audit = getRunLlmAuditFor(CLIENT, BUILD);
    expect(audit?.run_id).toBe(runIdFor(CLIENT, BUILD));
    expect(audit?.seo_run_id).toBe(audit?.run_id);
    expect(audit?.run_id_source).toBe("derived");
  });

  it("fails closed when two legs claim different runs", () => {
    recordCompetitiveLandscapeLeg({
      client_id: CLIENT,
      build_id: BUILD,
      ranking_llm_calls: 0,
      run_ref: "wb-run-123",
    });
    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      run_ref: "wb-run-999",
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
    });
    // A run whose legs disagree about which run they are cannot be correlated
    // by anyone, so it is never exported with one side silently picked.
    expect(() => getRunLlmAuditFor(CLIENT, BUILD)).toThrow(RunLlmAuditInvalidError);
  });

  it("rejects a router policy source it cannot canonicalize, end to end", () => {
    // The recorder carries an unrecognised value verbatim rather than
    // normalizing it into something plausible; the schema is what refuses it.
    // This is the whole reason the recorder's field is not narrowed.
    const recorder = new LlmRunRecorder(runIdFor(CLIENT, BUILD));
    recorder.attributeOperationCall({
      operation: "SEO_CONTENT_BLUEPRINT",
      purpose: "[bi] bp-g",
      attempt: "initial",
      descriptorRequiresSearch: false,
      decisions: [
        {
          taskId: "bp-g",
          clientId: CLIENT,
          timestamp: "2026-08-21T00:00:00.000Z",
          taskType: "strategic_reasoning",
          complexity: "high",
          provider: "openrouter",
          model: "a-model",
          estimatedCost: 0,
          reason: "test",
          searchRequired: false,
          searchPolicySource: "inferred",
          visionRequired: false,
          outcome: "SUCCESS",
        },
      ] as never,
    });
    expect(recorder.snapshot().operations[0]?.searchPolicySource).toBe("inferred");

    recordSeoContentBlueprintLeg({
      client_id: CLIENT,
      build_id: BUILD,
      evidence: { route_count: 2, batch_size: 4, batch_count: 1, completed_batches: 1 },
      recorder,
    });
    recorder.close();
    expect(() => getRunLlmAuditFor(CLIENT, BUILD)).toThrow(RunLlmAuditInvalidError);
  });

  it("ignores a blank run_ref rather than binding the run to nothing", () => {
    seedRun("   ");
    const audit = getRunLlmAuditFor(CLIENT, BUILD);
    expect(audit?.run_id_source).toBe("derived");
  });
});
