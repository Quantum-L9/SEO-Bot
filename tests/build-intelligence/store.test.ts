/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { sealIntelligenceArtifact, WEBSITE_INTELLIGENCE_SCHEMAS } from "@quantum-l9/bot-interop";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<{ artifactId: string; payloadDigest: string }> = [];
const insert = vi.fn(async () => undefined);

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: unknown) => value,
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
    insert: () => ({
      values: (value: { artifactId: string; payloadDigest: string }) => ({
        onConflictDoNothing: async () => {
          rows.push({ artifactId: value.artifactId, payloadDigest: value.payloadDigest });
          await insert(value);
        },
      }),
    }),
  }),
  schema: {
    buildIntelligenceArtifacts: {
      payloadDigest: "payloadDigest",
      artifactId: "artifactId",
    },
  },
}));

import {
  ArtifactDigestConflictError,
  persistIntelligenceArtifact,
} from "../../src/build-intelligence/store.js";

function artifact(digestSalt = "a") {
  return sealIntelligenceArtifact({
    artifact_type: "competitive_landscape",
    client_id: "client-1",
    build_id: "build-1",
    producer: { repo: "SEO-Bot", version: "2.1.0" },
    payload: {
      schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
      market: { niche: digestSalt, country: "United States", language: "English", device: "desktop" },
      query_portfolio: [],
      observations: [],
      domains: [],
      selected_donors: [{ domain: "a.com", aggregate_visibility: 1, observation_ids: ["o1"] }],
      exclusions: [],
      evidence_complete: true,
    },
  });
}

describe("persistIntelligenceArtifact", () => {
  beforeEach(() => {
    rows.length = 0;
    insert.mockClear();
  });

  it("inserts a new artifact", async () => {
    const result = await persistIntelligenceArtifact(artifact());
    expect(result).toEqual({ persisted: true, idempotent: false });
  });

  it("is idempotent for the same artifact id and digest", async () => {
    const first = artifact();
    rows.push({ artifactId: first.artifact_id, payloadDigest: first.integrity.payload_digest });
    const result = await persistIntelligenceArtifact(first);
    expect(result).toEqual({ persisted: false, idempotent: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed on ARTIFACT_DIGEST_CONFLICT", async () => {
    const first = artifact("a");
    rows.push({ artifactId: first.artifact_id, payloadDigest: "different-digest" });
    await expect(persistIntelligenceArtifact(first)).rejects.toBeInstanceOf(
      ArtifactDigestConflictError,
    );
  });
});
