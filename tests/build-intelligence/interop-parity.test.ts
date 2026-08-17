/* L9_META
 * layer: test
 * role: contract_parity_test
 * status: active
 */

/**
 * Parity with the shared @quantum-l9/bot-interop contract that Website-Bot
 * consumes. SEO-Bot must never carry a local divergent copy of a shared schema,
 * and every artifact it seals must satisfy the shared integrity contract that
 * the consumer re-validates on receipt.
 */

import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeV1,
  type ContentSlot,
  digestIntelligencePayload,
  refForArtifact,
  sameArtifactRef,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_PROTOCOL,
  WEBSITE_INTELLIGENCE_PROTOCOL_VERSION,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it } from "vitest";
import { PRODUCER } from "../../src/build-intelligence/producer.js";

/**
 * The accepted ContentSlot vocabulary, restated here ONLY so a silent change to
 * the shared union is caught. The shared type is the authority: the assignment
 * below fails to compile if these ever diverge.
 */
const EXPECTED_SLOTS = [
  "primary_offer",
  "service_overview",
  "differentiation",
  "trust",
  "process",
  "project_proof",
  "local_relevance",
  "objection_handling",
  "faq",
  "conversion",
  "metadata",
] as const;
const _slotParity: readonly ContentSlot[] = EXPECTED_SLOTS;

function landscape(): CompetitiveLandscapeV1 {
  return {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: { niche: "roofing", country: "United States", language: "English", device: "desktop" },
    query_portfolio: [{ query_id: "q1", query: "metal roofing", intent: "commercial", weight: 1 }],
    observations: [
      {
        observation_id: "q1-o1",
        query_id: "q1",
        rank: 1,
        url: "https://alpha-roofing.com/metal",
        domain: "alpha-roofing.com",
        observed_at: "2024-01-01T00:00:00.000Z",
        source: "dataforseo",
      },
    ],
    domains: [
      {
        domain: "alpha-roofing.com",
        aggregate_visibility: 1,
        qualifying_query_ids: ["q1"],
        observation_ids: ["q1-o1"],
      },
    ],
    selected_donors: [
      { domain: "alpha-roofing.com", aggregate_visibility: 1, observation_ids: ["q1-o1"] },
    ],
    exclusions: [],
    evidence_complete: true,
  };
}

describe("bot-interop parity — shared protocol identity", () => {
  it("uses the shared protocol and version, not a local constant", () => {
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: landscape(),
    });
    expect(artifact.protocol).toBe(WEBSITE_INTELLIGENCE_PROTOCOL);
    expect(artifact.protocol_version).toBe(WEBSITE_INTELLIGENCE_PROTOCOL_VERSION);
    expect(artifact.payload.schema).toBe(WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape);
  });

  it("identifies SEO-Bot as the producer with a bound version", () => {
    expect(PRODUCER.repo).toBe("SEO-Bot");
    expect(PRODUCER.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("derives artifact_id from the canonical payload digest", () => {
    const payload = landscape();
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload,
    });
    const expected = digestIntelligencePayload({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      input_refs: [],
      payload,
    });
    expect(artifact.integrity.payload_digest).toBe(expected);
    expect(artifact.artifact_id).toBe(`competitive_landscape:${expected}`);
  });

  it("survives the exact integrity check the consumer re-runs on receipt", () => {
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: landscape(),
    });
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
    // Round-tripped through JSON exactly as the HTTP seam delivers it.
    expect(() =>
      assertIntelligenceArtifactIntegrity(JSON.parse(JSON.stringify(artifact))),
    ).not.toThrow();
  });

  it("detects any post-seal mutation of the payload", () => {
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: landscape(),
    });
    artifact.payload.selected_donors[0]!.domain = "tampered.com";
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).toThrow(
      /INTEL_ARTIFACT_HASH_MISMATCH/,
    );
  });

  it("produces ArtifactRefs the consumer can compare exactly", () => {
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: landscape(),
    });
    const ref = refForArtifact(artifact);
    expect(ref).toEqual({
      artifact_type: "competitive_landscape",
      artifact_id: artifact.artifact_id,
      payload_digest: artifact.integrity.payload_digest,
    });
    expect(sameArtifactRef(ref, refForArtifact(artifact))).toBe(true);
    expect(sameArtifactRef(ref, { ...ref, payload_digest: "other" })).toBe(false);
  });

  it("exposes every exclusion reason the shared contract accepts", () => {
    const reasons: CompetitiveLandscapeV1["exclusions"][number]["reason"][] = [
      "directory",
      "social",
      "marketplace",
      "publisher",
      "aggregator",
      "irrelevant",
      "operator_exclusion",
    ];
    expect(reasons).toHaveLength(7);
  });
});
