/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import {
  assertIntelligenceArtifactIntegrity,
  refForArtifact,
  sameArtifactRef,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_PROTOCOL,
  WEBSITE_INTELLIGENCE_PROTOCOL_VERSION,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it } from "vitest";
import { PRODUCER } from "../../src/build-intelligence/producer.js";

describe("bot-interop artifact parity", () => {
  it("seals CompetitiveLandscape under the current shared protocol", () => {
    const artifact = sealIntelligenceArtifact({
      artifact_type: "competitive_landscape",
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: {
        schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
        market: {
          niche: "roofing",
          country: "United States",
          language: "English",
          device: "desktop",
        },
        query_portfolio: [],
        observations: [],
        domains: [],
        selected_donors: [],
        exclusions: [],
        evidence_complete: false,
      },
    });
    expect(artifact.protocol).toBe(WEBSITE_INTELLIGENCE_PROTOCOL);
    expect(artifact.protocol_version).toBe(WEBSITE_INTELLIGENCE_PROTOCOL_VERSION);
    expect(artifact.artifact_id).toBe(`competitive_landscape:${artifact.integrity.payload_digest}`);
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
    const ref = refForArtifact(artifact);
    expect(sameArtifactRef(ref, refForArtifact(artifact))).toBe(true);
  });

  it("produces a stable digest for an identical semantic payload", () => {
    const input = {
      artifact_type: "seo_content_blueprint" as const,
      client_id: "client-1",
      build_id: "build-1",
      producer: PRODUCER,
      payload: {
        schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
        competitive_landscape_ref: {
          artifact_type: "competitive_landscape" as const,
          artifact_id: "competitive_landscape:abc",
          payload_digest: "abc",
        },
        routes: [],
      },
    };
    const a = sealIntelligenceArtifact(input);
    const b = sealIntelligenceArtifact(input);
    expect(a.integrity.payload_digest).toBe(b.integrity.payload_digest);
    expect(a.artifact_id).toBe(b.artifact_id);
  });
});
