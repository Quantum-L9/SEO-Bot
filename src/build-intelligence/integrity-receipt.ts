/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

export type IntegrityVerdict = "PASS" | "FAIL" | "BLOCKED_ON_CONSUMER_PCC";

export interface SeoBuildIntelligenceIntegrityReceipt {
  identity: {
    seo_bot_sha: string;
    seo_bot_version: string;
    bot_interop_version: string;
    llm_router_version: string;
  };
  competitive: {
    request_identity: { client_id: string; build_id: string };
    query_count_original: number;
    query_count_expanded: number;
    real_dataforseo_evidence_count: number;
    qualified_candidate_count: number;
    excluded_candidate_count: number;
    selected_donor_count: number;
    selected_donor_refs: string[];
    evidence_complete: boolean;
    competitive_artifact_ref: { artifact_id: string; payload_digest: string };
    competitive_ranking_llm_calls: number;
  };
  seo_blueprint: {
    artifact_ref: { artifact_id: string; payload_digest: string };
    exact_competitive_landscape_ref: { artifact_id: string; payload_digest: string };
    route_count: number;
    invalid_slot_count: number;
    router_only_llm: boolean;
  } | null;
  structured_content: {
    executed: boolean;
    reason?: string;
    pcc_ref?: { artifact_id: string; payload_digest: string };
    package_ref?: { artifact_id: string; payload_digest: string };
    route_parity?: boolean;
    unsupported_claims?: number;
    repair_attempts?: number;
    router_only_llm?: boolean;
  };
  interop: { artifact_schema_parity: "PASS" | "FAIL" };
  final: { SEO_BUILD_INTELLIGENCE_INTEGRITY: IntegrityVerdict };
}

export function validateIntegrityReceipt(receipt: SeoBuildIntelligenceIntegrityReceipt): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  if (receipt.competitive.selected_donor_count !== 10) {
    failures.push("selected_donor_count != 10");
  }
  if (receipt.competitive.evidence_complete !== true) {
    failures.push("evidence_complete is not true");
  }
  if (receipt.competitive.competitive_ranking_llm_calls !== 0) {
    failures.push("competitive ranking used LLM");
  }
  if (receipt.seo_blueprint && receipt.seo_blueprint.invalid_slot_count !== 0) {
    failures.push("invalid content slots present");
  }
  if (
    receipt.seo_blueprint &&
    receipt.seo_blueprint.exact_competitive_landscape_ref.artifact_id !==
      receipt.competitive.competitive_artifact_ref.artifact_id
  ) {
    failures.push("SEO blueprint landscape ref mismatch");
  }
  if (receipt.interop.artifact_schema_parity !== "PASS") {
    failures.push("interop parity failed");
  }
  if (receipt.structured_content.executed) {
    if ((receipt.structured_content.unsupported_claims ?? 1) !== 0) {
      failures.push("unsupported claims present");
    }
    if ((receipt.structured_content.repair_attempts ?? 99) > 1) {
      failures.push("more than one repair attempt");
    }
    if (receipt.structured_content.route_parity !== true) {
      failures.push("structured content route parity failed");
    }
  }
  const expected: IntegrityVerdict = receipt.structured_content.executed
    ? failures.length === 0
      ? "PASS"
      : "FAIL"
    : failures.length === 0
      ? "BLOCKED_ON_CONSUMER_PCC"
      : "FAIL";
  if (receipt.final.SEO_BUILD_INTELLIGENCE_INTEGRITY !== expected) {
    failures.push(
      `final verdict ${receipt.final.SEO_BUILD_INTELLIGENCE_INTEGRITY} does not match expected ${expected}`,
    );
  }
  return { ok: failures.length === 0, failures };
}
