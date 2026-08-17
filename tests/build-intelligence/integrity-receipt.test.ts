/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import type { ArtifactRef } from "@quantum-l9/bot-interop";
import { describe, expect, it } from "vitest";
import {
  type SeoBuildIntelligenceIntegrityReceipt,
  validateIntegrityReceipt,
} from "../../src/build-intelligence/integrity-receipt.js";

const landscapeRef: ArtifactRef = {
  artifact_type: "competitive_landscape",
  artifact_id: "competitive_landscape:aaa",
  payload_digest: "aaa",
};
const blueprintRef: ArtifactRef = {
  artifact_type: "seo_content_blueprint",
  artifact_id: "seo_content_blueprint:bbb",
  payload_digest: "bbb",
};
const contractRef: ArtifactRef = {
  artifact_type: "page_content_contract",
  artifact_id: "page_content_contract:ccc",
  payload_digest: "ccc",
};
const packageRef: ArtifactRef = {
  artifact_type: "structured_content_package",
  artifact_id: "structured_content_package:ddd",
  payload_digest: "ddd",
};

function passingReceipt(): SeoBuildIntelligenceIntegrityReceipt {
  return {
    receipt_type: "SeoBuildIntelligenceIntegrityReceipt",
    receipt_version: "1.0",
    produced_at: "2026-08-17T00:00:00.000Z",
    identity: {
      seo_bot_sha: "9691264854bc3a656d23ee9f8fc9a03a04911fae",
      seo_bot_version: "2.1.0",
      bot_interop_version: "1.1.0",
      llm_router_version: "1.1.2",
    },
    competitive: {
      request_identity: {
        client_id: "safe-haven",
        build_id: "build-1",
        niche: "roofing",
        country: "United States",
      },
      query_count_original: 6,
      query_count_expanded: 12,
      expansion_rounds_used: 1,
      dataforseo_evidence_count: 180,
      candidate_domain_count: 42,
      qualified_candidate_count: 14,
      unknown_candidate_count: 18,
      excluded_candidate_count: 10,
      selected_donor_count: 10,
      selected_donor_domains: Array.from({ length: 10 }, (_, i) => `co-${i}.com`),
      evidence_complete: true,
      artifact_ref: landscapeRef,
      ranking_llm_calls: 0,
    },
    seo_blueprint: {
      artifact_ref: blueprintRef,
      competitive_landscape_ref: landscapeRef,
      route_count: 5,
      invalid_slot_count: 0,
      router_only_llm: true,
      direct_provider_calls: 0,
    },
    structured_content: {
      executed: true,
      page_content_contract_ref: contractRef,
      package_ref: packageRef,
      contract_route_count: 5,
      package_route_count: 5,
      route_parity: true,
      unsupported_claim_count: 0,
      failed_requirement_count: 0,
      repair_attempts: 1,
      repaired_route_count: 1,
      router_only_llm: true,
      direct_provider_calls: 0,
    },
    interop: { artifact_schema_parity: true, notes: [] },
  };
}

describe("SeoBuildIntelligenceIntegrityReceipt — PASS requires all three legs", () => {
  it("passes a complete, invariant-satisfying run", () => {
    expect(validateIntegrityReceipt(passingReceipt())).toEqual({ verdict: "PASS", violations: [] });
  });

  it("fails when the donor cohort is not exactly ten", () => {
    for (const count of [0, 3, 9, 11]) {
      const receipt = passingReceipt();
      receipt.competitive.selected_donor_count = count;
      receipt.competitive.selected_donor_domains = Array.from(
        { length: count },
        (_, i) => `co-${i}.com`,
      );
      const result = validateIntegrityReceipt(receipt);
      expect(result.verdict).toBe("FAIL");
      expect(result.violations.join(" ")).toMatch(/must be exactly 10/);
    }
  });

  it("fails when evidence_complete is false", () => {
    const receipt = passingReceipt();
    receipt.competitive.evidence_complete = false;
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });

  it("fails when the ranking path used any LLM call", () => {
    const receipt = passingReceipt();
    receipt.competitive.ranking_llm_calls = 1;
    const result = validateIntegrityReceipt(receipt);
    expect(result.verdict).toBe("FAIL");
    expect(result.violations.join(" ")).toMatch(/ranking_llm_calls/);
  });

  it("fails when there is no real DataForSEO evidence", () => {
    const receipt = passingReceipt();
    receipt.competitive.dataforseo_evidence_count = 0;
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });

  it("fails when the blueprint references a different landscape", () => {
    const receipt = passingReceipt();
    receipt.seo_blueprint.competitive_landscape_ref = {
      ...landscapeRef,
      payload_digest: "different",
      artifact_id: "competitive_landscape:different",
    };
    const result = validateIntegrityReceipt(receipt);
    expect(result.verdict).toBe("FAIL");
    expect(result.violations.join(" ")).toMatch(/does not match the exact CompetitiveLandscape/);
  });

  it("fails on an invalid content slot", () => {
    const receipt = passingReceipt();
    receipt.seo_blueprint.invalid_slot_count = 1;
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });

  it("fails when any leg bypassed llm-router", () => {
    const blueprintBypass = passingReceipt();
    blueprintBypass.seo_blueprint.direct_provider_calls = 1;
    expect(validateIntegrityReceipt(blueprintBypass).verdict).toBe("FAIL");

    const contentBypass = passingReceipt();
    if (contentBypass.structured_content.executed) {
      contentBypass.structured_content.direct_provider_calls = 2;
    }
    expect(validateIntegrityReceipt(contentBypass).verdict).toBe("FAIL");
  });

  it("fails on route-set drift between contract and package", () => {
    const receipt = passingReceipt();
    if (receipt.structured_content.executed) {
      receipt.structured_content.package_route_count = 4;
      receipt.structured_content.route_parity = false;
    }
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });

  it("fails on any surviving unsupported claim", () => {
    const receipt = passingReceipt();
    if (receipt.structured_content.executed) {
      receipt.structured_content.unsupported_claim_count = 1;
    }
    const result = validateIntegrityReceipt(receipt);
    expect(result.verdict).toBe("FAIL");
    expect(result.violations.join(" ")).toMatch(/unsupported_claim_count/);
  });

  it("fails when a route was repaired more than once", () => {
    const receipt = passingReceipt();
    if (receipt.structured_content.executed) {
      receipt.structured_content.repair_attempts = 2;
      receipt.structured_content.repaired_route_count = 1;
    }
    const result = validateIntegrityReceipt(receipt);
    expect(result.verdict).toBe("FAIL");
    expect(result.violations.join(" ")).toMatch(/at most 1 per route/);
  });

  it("allows one repair per route across a multi-route package", () => {
    const receipt = passingReceipt();
    if (receipt.structured_content.executed) {
      receipt.structured_content.repair_attempts = 3;
      receipt.structured_content.repaired_route_count = 3;
    }
    expect(validateIntegrityReceipt(receipt).verdict).toBe("PASS");
  });

  it("fails when more routes were repaired than the contract declares", () => {
    const receipt = passingReceipt();
    if (receipt.structured_content.executed) {
      receipt.structured_content.repaired_route_count = 9;
      receipt.structured_content.repair_attempts = 9;
    }
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });
});

describe("SeoBuildIntelligenceIntegrityReceipt — BLOCKED_ON_CONSUMER_PCC", () => {
  it("is available only when legs 1 and 2 are spotless", () => {
    const receipt = passingReceipt();
    receipt.structured_content = {
      executed: false,
      reason: "no exact consumer-produced PageContentContract available",
    };
    expect(validateIntegrityReceipt(receipt)).toEqual({
      verdict: "BLOCKED_ON_CONSUMER_PCC",
      violations: [],
    });
  });

  it("is NOT available when an earlier leg failed", () => {
    const receipt = passingReceipt();
    receipt.competitive.selected_donor_count = 3;
    receipt.competitive.selected_donor_domains = ["a.com", "b.com", "c.com"];
    receipt.structured_content = { executed: false, reason: "no consumer PCC" };
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });

  it("requires an explicit reason when the final leg did not run", () => {
    const receipt = passingReceipt();
    receipt.structured_content = { executed: false, reason: "  " };
    const result = validateIntegrityReceipt(receipt);
    expect(result.verdict).toBe("FAIL");
    expect(result.violations.join(" ")).toMatch(/no recorded reason/);
  });

  it("fails when identity is not bound", () => {
    const receipt = passingReceipt();
    receipt.identity.seo_bot_sha = "";
    expect(validateIntegrityReceipt(receipt).verdict).toBe("FAIL");
  });
});
