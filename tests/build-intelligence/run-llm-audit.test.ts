/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Fail-closed validation of `l9.seo-bot-run-llm-audit/v1`.
 *
 * Every test here proves the SAME thing from a different angle: the document
 * cannot claim something its own evidence does not support. Counters are
 * re-derived from their event lists, per-route generation/repair accounting is
 * re-checked against the one-repair invariant, and `searchPolicySource:
 * EXPLICIT` is only accepted when the governed operation actually supplied the
 * `requiresSearch` policy the router applied.
 */

import { describe, expect, it } from "vitest";
import {
  assertRunLlmAudit,
  RUN_LLM_AUDIT_SCHEMA,
  RunLlmAuditInvalidError,
  type RunLlmAuditOperationExecution,
  type RunLlmAuditV1,
  runIdFor,
  runLlmAuditViolations,
} from "../../src/build-intelligence/run-llm-audit.js";

const CLIENT = "client-1";
const BUILD = "build-1";

function operation(
  overrides: Partial<RunLlmAuditOperationExecution> = {},
): RunLlmAuditOperationExecution {
  return {
    operation: "SEO_CONTENT_BLUEPRINT",
    purpose: "[build-intelligence] seo-content-blueprint:global-intent:build-1",
    attempt: "initial",
    task_id: "task-1",
    provider: "openrouter",
    model: "some/model",
    searchRequired: false,
    searchPolicySource: "EXPLICIT",
    descriptor_requires_search: false,
    outcome: "SUCCESS",
    ...overrides,
  };
}

/** A minimal, internally consistent audit: 2 blueprint routes, 1 content route. */
function baseAudit(): RunLlmAuditV1 {
  return {
    schema: RUN_LLM_AUDIT_SCHEMA,
    run_id: runIdFor(CLIENT, BUILD),
    seo_run_id: runIdFor(CLIENT, BUILD),
    run_id_source: "derived",
    client_id: CLIENT,
    build_id: BUILD,
    produced_at: "2026-08-21T00:00:00.000Z",
    producer: { repo: "SEO-Bot", version: "2.1.0" },
    legs: {
      competitive_landscape: true,
      seo_content_blueprint: true,
      structured_content: true,
    },
    competitive_landscape: { executed: true, ranking_llm_calls: 0 },
    seo_content_blueprint: {
      executed: true,
      route_count: 2,
      batch_size: 4,
      batch_count: 1,
      completed_batches: 1,
    },
    structured_content: {
      executed: true,
      route_results: [
        {
          route_id: "home",
          path: "/",
          generation_calls: 1,
          repair_attempts: 0,
          semantic_validation_calls: 1,
        },
      ],
    },
    operations: {
      SEO_CONTENT_BLUEPRINT: [
        operation({ task_id: "bp-global" }),
        operation({ task_id: "bp-batch-1", purpose: "[build-intelligence] batch-1" }),
      ],
      STRUCTURED_CONTENT_GENERATION: [
        operation({
          operation: "STRUCTURED_CONTENT_GENERATION",
          task_id: "gen-home",
          purpose: "[build-intelligence] structured-content:home",
        }),
      ],
      CONTENT_VALIDATION: [
        operation({
          operation: "CONTENT_VALIDATION",
          task_id: "val-home",
          purpose: "[build-intelligence] content-validation:home",
        }),
      ],
    },
    direct_provider_bypass_count: 0,
    direct_provider_bypasses: [],
    unsupported_capability_combination_count: 0,
    unsupported_capability_combinations: [],
    attribution_failures: [],
  };
}

function violationsOf(mutate: (audit: RunLlmAuditV1) => void): string[] {
  const audit = baseAudit();
  mutate(audit);
  return runLlmAuditViolations(audit);
}

describe("l9.seo-bot-run-llm-audit/v1 — a consistent run validates", () => {
  it("accepts an audit whose every counter matches its evidence", () => {
    expect(() => assertRunLlmAudit(baseAudit())).not.toThrow();
    expect(runLlmAuditViolations(baseAudit())).toEqual([]);
  });

  it("derives run identity from (client_id, build_id) rather than trusting it", () => {
    expect(runIdFor(CLIENT, BUILD)).toBe(runIdFor(CLIENT, BUILD));
    expect(runIdFor(CLIENT, BUILD)).not.toBe(runIdFor(CLIENT, "build-2"));
    expect(violationsOf((audit) => (audit.run_id = "seo-run:invented")).join(" ")).toMatch(
      /run_id_source is derived but run_id is not the derived id/,
    );
  });
});

describe("exact per-route generation counts", () => {
  it("rejects a route whose generation count does not match its repair count", () => {
    // Two generation calls with zero repairs is not a shape the run can produce.
    const violations = violationsOf((audit) => {
      audit.structured_content.route_results[0]!.generation_calls = 2;
      audit.operations.STRUCTURED_CONTENT_GENERATION.push(
        operation({ operation: "STRUCTURED_CONTENT_GENERATION", task_id: "gen-home-2" }),
      );
    });
    expect(violations.join(" ")).toMatch(/generation_calls must equal repair_attempts \+ 1/);
  });

  it("rejects route counters that disagree with the attributed router decisions", () => {
    // The per-route counter claims a repair; the router log shows one call.
    const violations = violationsOf((audit) => {
      audit.structured_content.route_results[0]!.generation_calls = 2;
      audit.structured_content.route_results[0]!.repair_attempts = 1;
    });
    expect(violations.join(" ")).toMatch(
      /route_results account for 2 generation call\(s\) but 1 router decision/,
    );
  });

  it("rejects duplicate routes so a doubled count cannot hide as two entries", () => {
    const violations = violationsOf((audit) => {
      audit.structured_content.route_results.push({
        route_id: "home",
        path: "/",
        generation_calls: 1,
        repair_attempts: 0,
        semantic_validation_calls: 1,
      });
      audit.operations.STRUCTURED_CONTENT_GENERATION.push(
        operation({ operation: "STRUCTURED_CONTENT_GENERATION", task_id: "gen-home-dup" }),
      );
    });
    expect(violations).toContain("duplicate route_id in route_results: home");
    expect(violations).toContain("duplicate path in route_results: /");
  });
});

describe("zero/one repair attribution", () => {
  it("accepts exactly one repair on a repaired route", () => {
    const violations = violationsOf((audit) => {
      audit.structured_content.route_results[0] = {
        route_id: "home",
        path: "/",
        generation_calls: 2,
        repair_attempts: 1,
        semantic_validation_calls: 2,
      };
      audit.operations.STRUCTURED_CONTENT_GENERATION.push(
        operation({
          operation: "STRUCTURED_CONTENT_GENERATION",
          task_id: "gen-home-repair",
          attempt: "repair",
        }),
      );
      audit.operations.CONTENT_VALIDATION.push(
        operation({ operation: "CONTENT_VALIDATION", task_id: "val-home-2" }),
      );
    });
    expect(violations).toEqual([]);
  });

  it("rejects a second repair on the same route at the schema boundary", () => {
    const audit = baseAudit();
    audit.structured_content.route_results[0]!.repair_attempts = 2;
    audit.structured_content.route_results[0]!.generation_calls = 3;
    expect(() => assertRunLlmAudit(audit)).toThrow(RunLlmAuditInvalidError);
  });
});

describe("explicit search-policy recording", () => {
  it("rejects EXPLICIT when the governed operation supplied no requiresSearch policy", () => {
    const violations = violationsOf((audit) => {
      audit.operations.CONTENT_VALIDATION[0]!.descriptor_requires_search = null;
    });
    expect(violations.join(" ")).toMatch(
      /EXPLICIT but the governed operation supplied no requiresSearch policy/,
    );
  });

  it("rejects EXPLICIT whose applied value differs from the value supplied", () => {
    const violations = violationsOf((audit) => {
      audit.operations.SEO_CONTENT_BLUEPRINT[0]!.descriptor_requires_search = true;
    });
    expect(violations.join(" ")).toMatch(/applied searchRequired=false while the governed/);
  });

  it("rejects TASK_DEFAULT recorded for a call that did supply a policy", () => {
    const violations = violationsOf((audit) => {
      audit.operations.SEO_CONTENT_BLUEPRINT[0]!.searchPolicySource = "TASK_DEFAULT";
    });
    expect(violations.join(" ")).toMatch(/TASK_DEFAULT although the governed operation supplied/);
  });

  it("rejects a governed reasoning call that resolved to a search-backed route", () => {
    const violations = violationsOf((audit) => {
      const call = audit.operations.STRUCTURED_CONTENT_GENERATION[0]!;
      call.searchRequired = true;
      call.descriptor_requires_search = true;
    });
    expect(violations.join(" ")).toMatch(/resolved to a search-backed route/);
  });

  it("rejects an unknown policy source outright", () => {
    const audit = baseAudit() as unknown as {
      operations: { CONTENT_VALIDATION: Array<{ searchPolicySource: string }> };
    };
    audit.operations.CONTENT_VALIDATION[0]!.searchPolicySource = "inferred";
    expect(() => assertRunLlmAudit(audit)).toThrow(RunLlmAuditInvalidError);
  });
});

describe("batch evidence", () => {
  it("rejects a batch_count that is not the deterministic split of the route set", () => {
    const violations = violationsOf((audit) => {
      audit.seo_content_blueprint.route_count = 9; // ceil(9/4) === 3, not 1
    });
    expect(violations.join(" ")).toMatch(/a deterministic split of 9 route\(s\) at batch_size 4/);
  });

  it("rejects a partially completed batch split", () => {
    const violations = violationsOf((audit) => {
      audit.seo_content_blueprint.route_count = 8;
      audit.seo_content_blueprint.batch_count = 2;
      audit.seo_content_blueprint.completed_batches = 1;
      audit.operations.SEO_CONTENT_BLUEPRINT.push(operation({ task_id: "bp-batch-2" }));
    });
    expect(violations.join(" ")).toMatch(/completed_batches is 1 of 2/);
  });

  it("rejects fewer recorded calls than the split requires", () => {
    const violations = violationsOf((audit) => {
      audit.operations.SEO_CONTENT_BLUEPRINT.pop();
    });
    expect(violations.join(" ")).toMatch(/requires at least 2 \(global intent \+ 1 batch\(es\)\)/);
  });

  it("rejects batch evidence for a leg that never ran", () => {
    const violations = violationsOf((audit) => {
      audit.legs.seo_content_blueprint = false;
      audit.seo_content_blueprint.executed = false;
    });
    expect(violations.join(" ")).toMatch(/batch evidence for a leg that never ran/);
  });
});

describe("ranking LLM count", () => {
  it("rejects any LLM call on the deterministic ranking path", () => {
    const violations = violationsOf((audit) => {
      audit.competitive_landscape.ranking_llm_calls = 1;
    });
    expect(violations.join(" ")).toMatch(
      /competitive_landscape\.ranking_llm_calls is 1, must be 0/,
    );
  });
});

describe("bypass counter", () => {
  it("rejects a bypass count that does not equal the recorded bypass events", () => {
    const violations = violationsOf((audit) => {
      audit.direct_provider_bypass_count = 3;
    });
    expect(violations.join(" ")).toMatch(
      /direct_provider_bypass_count is 3 but 0 bypass event\(s\) were recorded/,
    );
  });

  it("rejects a fabricated zero when bypass events were recorded", () => {
    const violations = violationsOf((audit) => {
      audit.direct_provider_bypasses.push({
        site: "aeo-geo:answer-engine-observation",
        engine: "perplexity",
        rationale: "the engine is the measurement subject",
      });
    });
    expect(violations.join(" ")).toMatch(
      /direct_provider_bypass_count is 0 but 1 bypass event\(s\) were recorded/,
    );
  });

  it("accepts a non-zero count backed by the same number of events", () => {
    const violations = violationsOf((audit) => {
      audit.direct_provider_bypasses.push({
        site: "aeo-geo:answer-engine-observation",
        engine: "perplexity",
        rationale: "the engine is the measurement subject",
      });
      audit.direct_provider_bypass_count = 1;
    });
    expect(violations).toEqual([]);
  });
});

describe("unsupported capability counter", () => {
  it("rejects a count that does not equal the recorded rejections", () => {
    const violations = violationsOf((audit) => {
      audit.unsupported_capability_combination_count = 2;
    });
    expect(violations.join(" ")).toMatch(
      /unsupported_capability_combination_count is 2 but 0 rejection\(s\) were recorded/,
    );
  });

  it("accepts a non-zero count backed by the same number of rejections", () => {
    const violations = violationsOf((audit) => {
      audit.unsupported_capability_combinations.push({
        code: "UNSUPPORTED_CAPABILITY_COMBINATION",
        task_type: "layout_validation",
        operation: null,
        message: "no provider serves search and vision together",
      });
      audit.unsupported_capability_combination_count = 1;
    });
    expect(violations).toEqual([]);
  });
});

describe("malformed / missing evidence rejection", () => {
  it("rejects a non-object", () => {
    for (const value of [null, undefined, 42, "audit", []]) {
      expect(() => assertRunLlmAudit(value)).toThrow(RunLlmAuditInvalidError);
    }
  });

  it("rejects a foreign or missing schema id", () => {
    for (const schema of [undefined, "", "l9.seo-bot-run-llm-audit/v2"]) {
      const audit = { ...baseAudit(), schema } as unknown;
      expect(() => assertRunLlmAudit(audit)).toThrow(RunLlmAuditInvalidError);
    }
  });

  it("rejects an audit missing a required section", () => {
    for (const key of [
      "run_id",
      "seo_run_id",
      "competitive_landscape",
      "seo_content_blueprint",
      "structured_content",
      "operations",
      "direct_provider_bypass_count",
      "unsupported_capability_combination_count",
    ] as const) {
      const audit = baseAudit() as unknown as Record<string, unknown>;
      delete audit[key];
      expect(() => assertRunLlmAudit(audit), `${key} must be required`).toThrow(
        RunLlmAuditInvalidError,
      );
    }
  });

  it("rejects an unknown field rather than silently accepting an extension", () => {
    const audit = { ...baseAudit(), verdict: "PASS" } as unknown;
    expect(() => assertRunLlmAudit(audit)).toThrow(RunLlmAuditInvalidError);
  });

  it("rejects a missing operations bucket", () => {
    const audit = baseAudit() as unknown as { operations: Record<string, unknown> };
    delete audit.operations.CONTENT_VALIDATION;
    expect(() => assertRunLlmAudit(audit)).toThrow(RunLlmAuditInvalidError);
  });

  it("rejects an audit carrying an unattributed router call", () => {
    const violations = violationsOf((audit) => {
      audit.attribution_failures.push({
        operation: "CONTENT_VALIDATION",
        purpose: "[build-intelligence] content-validation:home",
        attempt: "initial",
        reason: "expected exactly 1 new router decision for this call, observed 0",
      });
    });
    expect(violations.join(" ")).toMatch(/unattributed CONTENT_VALIDATION initial call/);
  });

  it("reports every violation at once instead of stopping at the first", () => {
    const audit = baseAudit();
    audit.competitive_landscape.ranking_llm_calls = 2;
    audit.direct_provider_bypass_count = 5;
    try {
      assertRunLlmAudit(audit);
      throw new Error("expected the audit to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RunLlmAuditInvalidError);
      expect((error as RunLlmAuditInvalidError).violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("refuses to mint a run id without a complete run identity", () => {
    expect(() => runIdFor("", BUILD)).toThrow(RunLlmAuditInvalidError);
    expect(() => runIdFor(CLIENT, "   ")).toThrow(RunLlmAuditInvalidError);
  });
});
