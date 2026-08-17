/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it } from "vitest";
import {
  type SeoBuildIntelligenceIntegrityReceipt,
  validateIntegrityReceipt,
} from "../../src/build-intelligence/integrity-receipt.js";

function receipt(
  overrides: Partial<SeoBuildIntelligenceIntegrityReceipt> = {},
): SeoBuildIntelligenceIntegrityReceipt {
  return {
    identity: {
      seo_bot_sha: "abc",
      seo_bot_version: "2.1.0",
      bot_interop_version: "1.1.0",
      llm_router_version: "1.1.2",
    },
    competitive: {
      request_identity: { client_id: "c", build_id: "b" },
      query_count_original: 5,
      query_count_expanded: 3,
      real_dataforseo_evidence_count: 40,
      qualified_candidate_count: 12,
      excluded_candidate_count: 4,
      selected_donor_count: 10,
      selected_donor_refs: Array.from({ length: 10 }, (_, i) => `d${i}.com`),
      evidence_complete: true,
      competitive_artifact_ref: { artifact_id: "competitive_landscape:x", payload_digest: "x" },
      competitive_ranking_llm_calls: 0,
    },
    seo_blueprint: {
      artifact_ref: { artifact_id: "seo_content_blueprint:y", payload_digest: "y" },
      exact_competitive_landscape_ref: {
        artifact_id: "competitive_landscape:x",
        payload_digest: "x",
      },
      route_count: 3,
      invalid_slot_count: 0,
      router_only_llm: true,
    },
    structured_content: {
      executed: false,
      reason: "CONSUMER_PCC_REQUIRED_FOR_FINAL_SEAM",
    },
    interop: { artifact_schema_parity: "PASS" },
    final: { SEO_BUILD_INTELLIGENCE_INTEGRITY: "BLOCKED_ON_CONSUMER_PCC" },
    ...overrides,
  };
}

describe("SeoBuildIntelligenceIntegrityReceipt", () => {
  it("accepts a blocked-on-PCC receipt when steps 1-2 passed", () => {
    expect(validateIntegrityReceipt(receipt()).ok).toBe(true);
  });

  it("rejects a receipt that claims PASS without structured content", () => {
    const result = validateIntegrityReceipt(
      receipt({ final: { SEO_BUILD_INTELLIGENCE_INTEGRITY: "PASS" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a 3-donor complete claim", () => {
    const base = receipt();
    const result = validateIntegrityReceipt({
      ...base,
      competitive: { ...base.competitive, selected_donor_count: 3, evidence_complete: true },
      final: { SEO_BUILD_INTELLIGENCE_INTEGRITY: "FAIL" },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("selected_donor_count != 10");
  });
});
