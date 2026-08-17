/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 7 — Build-intelligence artifact persistence (single table)
 *
 * Content-addressed, idempotent, fail-closed on digest conflict. Re-persisting
 * the SAME sealed artifact is a no-op; attempting to persist a DIFFERENT payload
 * under an existing artifact_id throws (content addressing must never lie).
 * Persistence is best-effort at the API boundary: a store failure never
 * compromises the producer transaction — the sealed artifact is still returned.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { WebsiteIntelligenceArtifact } from "@quantum-l9/bot-interop";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";

const logger = createModuleLogger("build-intelligence:store");

export class ArtifactDigestConflictError extends Error {
  readonly code = "ARTIFACT_DIGEST_CONFLICT";
  constructor(artifactId: string) {
    super(
      `ARTIFACT_DIGEST_CONFLICT: refusing to overwrite artifact ${artifactId} with a different payload digest`,
    );
    this.name = "ArtifactDigestConflictError";
  }
}

/**
 * Persist a sealed intelligence artifact. Idempotent by `artifact_id`:
 *   - not present    → inserted
 *   - present, same digest → no-op (idempotent)
 *   - present, different digest → ArtifactDigestConflictError (fail closed)
 */
export async function persistIntelligenceArtifact(
  artifact: WebsiteIntelligenceArtifact,
): Promise<{ persisted: boolean; idempotent: boolean }> {
  const db = getDb();
  const table = schema.buildIntelligenceArtifacts;

  const [existing] = await db
    .select({ payloadDigest: table.payloadDigest })
    .from(table)
    .where(eq(table.artifactId, artifact.artifact_id))
    .limit(1);

  if (existing) {
    if (existing.payloadDigest !== artifact.integrity.payload_digest) {
      throw new ArtifactDigestConflictError(artifact.artifact_id);
    }
    return { persisted: false, idempotent: true };
  }

  await db
    .insert(table)
    .values({
      clientId: artifact.client_id,
      buildId: artifact.build_id,
      artifactType: artifact.artifact_type,
      artifactId: artifact.artifact_id,
      payloadDigest: artifact.integrity.payload_digest,
      payload: artifact.payload as unknown as Record<string, unknown>,
      producedAt: new Date(artifact.produced_at),
    })
    .onConflictDoNothing({ target: table.artifactId });

  logger.info(
    {
      clientId: artifact.client_id,
      buildId: artifact.build_id,
      artifactType: artifact.artifact_type,
      artifactId: artifact.artifact_id,
    },
    "Build-intelligence artifact persisted",
  );
  return { persisted: true, idempotent: false };
}
