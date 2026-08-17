/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SeoBuildIntelligenceIntegrityReceipt
 *
 * One machine-readable record proving that a real producer seam run satisfied
 * every hard invariant of the REDESIGN_IMPROVE build-intelligence transaction:
 * exactly ten qualified donors, zero LLM calls in the ranking path, exact
 * artifact lineage on both downstream legs, and at most one bounded content
 * repair.
 *
 * The receipt does NOT decide the verdict — `validateIntegrityReceipt` does,
 * from the recorded evidence. A receipt cannot claim PASS by asserting it; it
 * passes only when every invariant below holds.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { ArtifactRef } from "@quantum-l9/bot-interop";

export const REQUIRED_DONOR_COUNT = 10;
export const MAX_CONTENT_REPAIR_ATTEMPTS = 1;

export type IntegrityVerdict = "PASS" | "FAIL" | "BLOCKED_ON_CONSUMER_PCC";

export interface ReceiptIdentity {
  seo_bot_sha: string;
  seo_bot_version: string;
  bot_interop_version: string;
  llm_router_version: string;
}

export interface CompetitiveReceiptLeg {
  request_identity: { client_id: string; build_id: string; niche: string; country: string };
  query_count_original: number;
  query_count_expanded: number;
  expansion_rounds_used: number;
  dataforseo_evidence_count: number;
  candidate_domain_count: number;
  qualified_candidate_count: number;
  unknown_candidate_count: number;
  excluded_candidate_count: number;
  selected_donor_count: number;
  selected_donor_domains: string[];
  evidence_complete: boolean;
  artifact_ref: ArtifactRef;
  /** Must be 0: ranking authority is deterministic DataForSEO evidence. */
  ranking_llm_calls: number;
}

export interface BlueprintReceiptLeg {
  artifact_ref: ArtifactRef;
  competitive_landscape_ref: ArtifactRef;
  route_count: number;
  invalid_slot_count: number;
  /** Every LLM call on this leg went through @quantum-l9/llm-router. */
  router_only_llm: boolean;
  direct_provider_calls: number;
}

export type StructuredContentReceiptLeg =
  | {
      executed: false;
      /** Exact reason the final leg could not run. */
      reason: string;
    }
  | {
      executed: true;
      page_content_contract_ref: ArtifactRef;
      package_ref: ArtifactRef;
      contract_route_count: number;
      package_route_count: number;
      route_parity: boolean;
      unsupported_claim_count: number;
      failed_requirement_count: number;
      repair_attempts: number;
      router_only_llm: boolean;
      direct_provider_calls: number;
    };

export interface SeoBuildIntelligenceIntegrityReceipt {
  receipt_type: "SeoBuildIntelligenceIntegrityReceipt";
  receipt_version: "1.0";
  produced_at: string;
  identity: ReceiptIdentity;
  competitive: CompetitiveReceiptLeg;
  seo_blueprint: BlueprintReceiptLeg;
  structured_content: StructuredContentReceiptLeg;
  interop: { artifact_schema_parity: boolean; notes: string[] };
}

export interface ReceiptValidation {
  verdict: IntegrityVerdict;
  violations: string[];
}

/**
 * Decide the receipt's verdict from its evidence.
 *
 * PASS requires all three producer legs proven. BLOCKED_ON_CONSUMER_PCC is
 * permitted ONLY when the competitive and blueprint legs are fully clean and
 * the sole missing evidence is an exact consumer-produced PageContentContract.
 * Everything else is FAIL.
 */
export function validateIntegrityReceipt(
  receipt: SeoBuildIntelligenceIntegrityReceipt,
): ReceiptValidation {
  const violations: string[] = [];

  // ── Identity ────────────────────────────────────────────────────────────────
  for (const [key, value] of Object.entries(receipt.identity)) {
    if (!value || typeof value !== "string") {
      violations.push(`identity.${key} is not bound`);
    }
  }

  // ── Leg 1: CompetitiveLandscape ─────────────────────────────────────────────
  const competitive = receipt.competitive;
  if (competitive.selected_donor_count !== REQUIRED_DONOR_COUNT) {
    violations.push(
      `competitive.selected_donor_count is ${competitive.selected_donor_count}, must be exactly ${REQUIRED_DONOR_COUNT}`,
    );
  }
  if (competitive.selected_donor_domains.length !== competitive.selected_donor_count) {
    violations.push("competitive.selected_donor_domains does not match selected_donor_count");
  }
  if (
    new Set(competitive.selected_donor_domains).size !== competitive.selected_donor_domains.length
  ) {
    violations.push("competitive.selected_donor_domains contains a duplicate");
  }
  if (!competitive.evidence_complete) {
    violations.push("competitive.evidence_complete is false");
  }
  if (competitive.ranking_llm_calls !== 0) {
    violations.push(
      `competitive.ranking_llm_calls is ${competitive.ranking_llm_calls}, must be 0 (deterministic rank authority)`,
    );
  }
  if (competitive.dataforseo_evidence_count <= 0) {
    violations.push("competitive.dataforseo_evidence_count is 0 — no real SERP evidence");
  }
  if (competitive.query_count_expanded < competitive.query_count_original) {
    violations.push("competitive.query_count_expanded is smaller than the original portfolio");
  }
  if (competitive.qualified_candidate_count < REQUIRED_DONOR_COUNT) {
    violations.push(
      `competitive.qualified_candidate_count is ${competitive.qualified_candidate_count}, cannot support ${REQUIRED_DONOR_COUNT} donors`,
    );
  }
  if (!competitive.artifact_ref?.artifact_id || !competitive.artifact_ref?.payload_digest) {
    violations.push("competitive.artifact_ref is not a complete ArtifactRef");
  }

  // ── Leg 2: SEOContentBlueprint ──────────────────────────────────────────────
  const blueprint = receipt.seo_blueprint;
  if (!sameRef(blueprint.competitive_landscape_ref, competitive.artifact_ref)) {
    violations.push(
      "seo_blueprint.competitive_landscape_ref does not match the exact CompetitiveLandscape produced",
    );
  }
  if (blueprint.route_count <= 0) {
    violations.push("seo_blueprint.route_count is 0");
  }
  if (blueprint.invalid_slot_count !== 0) {
    violations.push(
      `seo_blueprint.invalid_slot_count is ${blueprint.invalid_slot_count}, must be 0`,
    );
  }
  if (!blueprint.router_only_llm || blueprint.direct_provider_calls !== 0) {
    violations.push("seo_blueprint used a direct provider call outside @quantum-l9/llm-router");
  }

  // ── Leg 3: StructuredContentPackage ─────────────────────────────────────────
  const content = receipt.structured_content;
  const contentViolations: string[] = [];
  if (content.executed) {
    if (!content.route_parity || content.contract_route_count !== content.package_route_count) {
      contentViolations.push("structured_content route set does not match the PageContentContract");
    }
    if (content.unsupported_claim_count !== 0) {
      contentViolations.push(
        `structured_content.unsupported_claim_count is ${content.unsupported_claim_count}, must be 0`,
      );
    }
    if (content.failed_requirement_count !== 0) {
      contentViolations.push(
        `structured_content.failed_requirement_count is ${content.failed_requirement_count}, must be 0`,
      );
    }
    if (content.repair_attempts > MAX_CONTENT_REPAIR_ATTEMPTS) {
      contentViolations.push(
        `structured_content.repair_attempts is ${content.repair_attempts}, at most ${MAX_CONTENT_REPAIR_ATTEMPTS} is permitted`,
      );
    }
    if (!content.router_only_llm || content.direct_provider_calls !== 0) {
      contentViolations.push(
        "structured_content used a direct provider call outside @quantum-l9/llm-router",
      );
    }
    if (!content.package_ref?.artifact_id || !content.page_content_contract_ref?.artifact_id) {
      contentViolations.push("structured_content refs are incomplete");
    }
  } else if (!content.reason?.trim()) {
    contentViolations.push("structured_content.executed is false with no recorded reason");
  }

  // ── Interop ─────────────────────────────────────────────────────────────────
  if (!receipt.interop.artifact_schema_parity) {
    violations.push("interop.artifact_schema_parity is false");
  }

  const allViolations = [...violations, ...contentViolations];

  // The first two legs must be spotless before the "blocked" verdict is even
  // available — it is a narrower claim than PASS, never a softer FAIL.
  if (violations.length === 0 && !content.executed && contentViolations.length === 0) {
    return { verdict: "BLOCKED_ON_CONSUMER_PCC", violations: [] };
  }
  if (allViolations.length === 0) {
    return { verdict: "PASS", violations: [] };
  }
  return { verdict: "FAIL", violations: allViolations };
}

function sameRef(a: ArtifactRef | undefined, b: ArtifactRef | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.artifact_type === b.artifact_type &&
    a.artifact_id === b.artifact_id &&
    a.payload_digest === b.payload_digest
  );
}
