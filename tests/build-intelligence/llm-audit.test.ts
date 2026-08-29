/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The audit projection must identify governed calls by the decision ids the
 * LlmService recorded at dispatch, and must scope both sides of the bypass
 * comparison to the same client. Classifying by the generic TaskType swept
 * ungoverned daemon traffic into the audit; a process-wide expected count
 * reported one tenant's calls against another's.
 */

import { SearchPolicySource, TaskType } from "@quantum-l9/llm-router";
import { describe, expect, it } from "vitest";
import { projectLlmAudit } from "../../src/build-intelligence/llm-audit.js";
import type { LlmService } from "../../src/services/llm.js";

interface FakeDecision {
  taskId: string;
  clientId: string;
  taskType: TaskType;
  timestamp: string;
  searchRequired: boolean;
  searchPolicySource: SearchPolicySource;
  outcome?: "SUCCESS" | "FAILED";
}

const decision = (
  taskId: string,
  clientId: string,
  taskType: TaskType,
  searchPolicySource: SearchPolicySource = SearchPolicySource.EXPLICIT,
): FakeDecision => ({
  taskId,
  clientId,
  taskType,
  timestamp: "2026-01-01T00:00:00.000Z",
  searchRequired: false,
  searchPolicySource,
  outcome: "SUCCESS",
});

/** A stand-in exposing exactly the surface `projectLlmAudit` consumes. */
function fakeLlm(args: {
  decisions: FakeDecision[];
  governed: Record<string, Record<string, string[]>>;
  counts: Record<string, Record<string, number>>;
}): LlmService {
  return {
    getRouter: () => ({ getCallLog: () => args.decisions }),
    getGovernedDecisionIds: (clientId?: string) => {
      const byOperation = new Map<string, Set<string>>();
      for (const [operation, byClient] of Object.entries(args.governed)) {
        const ids = new Set<string>();
        for (const [client, taskIds] of Object.entries(byClient)) {
          if (clientId !== undefined && client !== clientId) continue;
          for (const id of taskIds) ids.add(id);
        }
        byOperation.set(operation, ids);
      }
      return byOperation;
    },
    getPolicyCallCounts: (clientId?: string) => {
      const counts: Record<string, number> = {};
      for (const [operation, byClient] of Object.entries(args.counts)) {
        counts[operation] =
          clientId === undefined
            ? Object.values(byClient).reduce((a, b) => a + b, 0)
            : (byClient[clientId] ?? 0);
      }
      return counts;
    },
  } as unknown as LlmService;
}

describe("projectLlmAudit", () => {
  it("ignores an ungoverned call that shares a governed task type", () => {
    const llm = fakeLlm({
      decisions: [
        decision("governed-1", "client-a", TaskType.CONTENT_GENERATION),
        // Routine daemon work via generateContent(): same task type, and it
        // carries the task-default search policy.
        decision(
          "daemon-1",
          "client-a",
          TaskType.CONTENT_GENERATION,
          SearchPolicySource.TASK_DEFAULT,
        ),
      ],
      governed: { STRUCTURED_CONTENT_GENERATION: { "client-a": ["governed-1"] } },
      counts: { STRUCTURED_CONTENT_GENERATION: { "client-a": 1 } },
    });

    const projection = projectLlmAudit(llm, { clientId: "client-a" });

    expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
    expect(projection.operations.STRUCTURED_CONTENT_GENERATION[0]?.task_id).toBe("governed-1");
    expect(projection.operations.STRUCTURED_CONTENT_GENERATION[0]?.search_policy_source).toBe(
      "EXPLICIT",
    );
    expect(projection.direct_provider_bypass_count).toBe(0);
  });

  it("does not count another client's governed calls as this client's bypass", () => {
    const llm = fakeLlm({
      decisions: [
        decision("a-1", "client-a", TaskType.CONTENT_GENERATION),
        decision("b-1", "client-b", TaskType.CONTENT_GENERATION),
      ],
      governed: {
        STRUCTURED_CONTENT_GENERATION: { "client-a": ["a-1"], "client-b": ["b-1"] },
      },
      counts: { STRUCTURED_CONTENT_GENERATION: { "client-a": 1, "client-b": 1 } },
    });

    for (const clientId of ["client-a", "client-b"]) {
      const projection = projectLlmAudit(llm, { clientId });
      expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
      expect(projection.direct_provider_bypass_count).toBe(0);
    }
  });

  it("still measures a real bypass: an expected call with no logged decision", () => {
    const llm = fakeLlm({
      decisions: [decision("a-1", "client-a", TaskType.CONTENT_GENERATION)],
      governed: { STRUCTURED_CONTENT_GENERATION: { "client-a": ["a-1"] } },
      counts: { STRUCTURED_CONTENT_GENERATION: { "client-a": 2 } },
    });

    const projection = projectLlmAudit(llm, { clientId: "client-a" });

    expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
    expect(projection.direct_provider_bypass_count).toBe(1);
  });
});
