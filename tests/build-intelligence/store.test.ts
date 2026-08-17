/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import {
  type CompetitiveLandscapeV1,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const existingRow = vi.hoisted(() => ({ value: [] as Array<{ payloadDigest: string }> }));
const inserted = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/core/database/index.js", () => ({
  schema: { buildIntelligenceArtifacts: { artifactId: "artifact_id" } },
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => existingRow.value }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          inserted.rows.push(row);
        },
      }),
    }),
  }),
}));

import {
  ArtifactDigestConflictError,
  persistIntelligenceArtifact,
} from "../../src/build-intelligence/store.js";

function landscape(niche: string) {
  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: { niche, country: "United States", language: "English", device: "desktop" },
    query_portfolio: [],
    observations: [],
    domains: [],
    selected_donors: [],
    exclusions: [],
    evidence_complete: true,
  };
  return sealIntelligenceArtifact({
    artifact_type: "competitive_landscape",
    client_id: "client-1",
    build_id: "build-1",
    producer: { repo: "SEO-Bot", version: "2.1.0" },
    payload,
  });
}

beforeEach(() => {
  existingRow.value = [];
  inserted.rows = [];
});

describe("build-intelligence artifact store — content addressing", () => {
  it("inserts an artifact that is not yet stored", async () => {
    const result = await persistIntelligenceArtifact(landscape("roofing"));
    expect(result).toEqual({ persisted: true, idempotent: false });
    expect(inserted.rows).toHaveLength(1);
  });

  it("is a no-op when the same artifact is persisted again (retry-safe)", async () => {
    const artifact = landscape("roofing");
    existingRow.value = [{ payloadDigest: artifact.integrity.payload_digest }];
    const result = await persistIntelligenceArtifact(artifact);
    expect(result).toEqual({ persisted: false, idempotent: true });
    expect(inserted.rows).toHaveLength(0);
  });

  it("fails closed rather than overwriting a stored artifact with a different digest", async () => {
    existingRow.value = [{ payloadDigest: "a-completely-different-digest" }];
    await expect(persistIntelligenceArtifact(landscape("roofing"))).rejects.toBeInstanceOf(
      ArtifactDigestConflictError,
    );
    expect(inserted.rows).toHaveLength(0);
  });

  it("gives semantically different payloads different content-addressed ids", () => {
    const a = landscape("roofing");
    const b = landscape("plumbing");
    expect(a.artifact_id).not.toBe(b.artifact_id);
    expect(a.integrity.payload_digest).not.toBe(b.integrity.payload_digest);
  });

  it("gives an identical payload the identical content-addressed id", () => {
    expect(landscape("roofing").artifact_id).toBe(landscape("roofing").artifact_id);
  });
});
