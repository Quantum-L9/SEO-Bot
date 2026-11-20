/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The audit projection reads recorded DeepSeek calls. It does not consult the
 * router call log, so daemon traffic that never entered the run recorder cannot
 * appear, and one client's calls are not attributed to another client.
 */

import { describe, expect, it } from "vitest";
import { projectLlmAudit, type RecordedAuditCall } from "../../src/build-intelligence/llm-audit.js";

function call(
  overrides: Partial<RecordedAuditCall> & Pick<RecordedAuditCall, "client_id" | "task_id">,
): RecordedAuditCall {
  return {
    operation: "STRUCTURED_CONTENT_GENERATION",
    timestamp: "2026-01-01T00:00:00.000Z",
    search_required: false,
    search_policy_source: "EXPLICIT",
    outcome: "SUCCESS",
    ...overrides,
  };
}

describe("projectLlmAudit", () => {
  it("ignores a recorded operation that is not one of the three governed producers", () => {
    const projection = projectLlmAudit({
      calls: [
        call({ client_id: "client-a", task_id: "governed-1" }),
        call({
          client_id: "client-a",
          task_id: "daemon-1",
          operation: "INTELLIGENCE_ACTION_SELECTION",
          search_policy_source: "TASK_DEFAULT",
        }),
      ],
      directProviderBypassCount: 0,
    });

    expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
    expect(projection.operations.STRUCTURED_CONTENT_GENERATION[0]?.task_id).toBe("governed-1");
    expect(projection.operations.STRUCTURED_CONTENT_GENERATION[0]?.search_policy_source).toBe(
      "EXPLICIT",
    );
    expect(projection.direct_provider_bypass_count).toBe(0);
  });

  it("keeps each client's recorded calls separate when the caller already scoped them", () => {
    for (const clientId of ["client-a", "client-b"]) {
      const projection = projectLlmAudit({
        calls: [call({ client_id: clientId, task_id: `${clientId}-1` })],
        directProviderBypassCount: 0,
      });
      expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
      expect(projection.operations.STRUCTURED_CONTENT_GENERATION[0]?.client_id).toBe(clientId);
      expect(projection.direct_provider_bypass_count).toBe(0);
    }
  });

  it("reports the measured bypass count from the recorder", () => {
    const projection = projectLlmAudit({
      calls: [call({ client_id: "client-a", task_id: "a-1" })],
      directProviderBypassCount: 1,
    });

    expect(projection.operations.STRUCTURED_CONTENT_GENERATION).toHaveLength(1);
    expect(projection.direct_provider_bypass_count).toBe(1);
  });
});
