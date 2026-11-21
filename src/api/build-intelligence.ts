/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 8 — Build-time intelligence API (l9.website-intelligence/v1 seam)
 *
 * Direct HTTP endpoints on the existing Fastify surface (no second HTTP server).
 * Website-Bot is the named consumer. Operator auth + rate limiting are applied
 * by the shared onRequest hooks in api/security.ts — these routes are NOT
 * auth-exempt.
 *
 * Three producer endpoints plus the run-evidence read surface that exports
 * `l9.seo-bot-run-llm-audit/v1` for the run those three calls make up. Run
 * identity is deterministic in (client_id, build_id), so the consumer needs no
 * handshake to find its own evidence.
 *
 * Every endpoint: validate request → invoke owned service → validate resulting
 * artifact → persist (best-effort) → return the sealed artifact.
 *
 * PROVIDER/MODEL NEVER LEAK: request bodies are `.strict()`, so `provider`,
 * `model`, `temperature`, Perplexity/OpenRouter flags, or a raw system prompt
 * are rejected at the schema boundary (400) rather than reaching routing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
  FIRST_PARTY_AUTHORITY_SCHEMA,
  type IntelligenceArtifactType,
  type PageContentContractArtifact,
  type SEOContentBlueprintArtifact,
  type VerifiedBusinessFact,
  type WebsiteIntelligenceArtifact,
} from "@quantum-l9/bot-interop";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CompetitiveDonorQualificationError,
  CompetitiveEvidenceIncompleteError,
  CompetitiveLandscapeInvalidError,
  createCompetitiveLandscape,
} from "../build-intelligence/competitive-landscape.js";
import {
  BudgetExhaustedError,
  DeepSeekOutputTruncatedError,
  DeepSeekTransportError,
  type ProviderFailureSite,
  ProviderRequestError,
  TaskValidationError,
} from "../build-intelligence/deepseek-llm.js";
import { projectLlmAudit } from "../build-intelligence/llm-audit.js";
import { runPreflight } from "../build-intelligence/preflight.js";
import {
  PROVIDER_ATTEMPTS_SCHEMA,
  ProviderAttemptsInvalidError,
  type ProviderLegFailure,
} from "../build-intelligence/provider-attempts.js";
import {
  getRunLlmAudit,
  getRunLlmAuditFor,
  getRunProviderAttempts,
  recordCompetitiveLandscapeLeg,
  recordedCallsForAudit,
  recordProviderAttempts,
  recordSeoContentBlueprintLeg,
  recordStructuredContentLeg,
} from "../build-intelligence/run-evidence-store.js";
import {
  RUN_LLM_AUDIT_SCHEMA,
  RunLlmAuditInvalidError,
  runIdFor,
} from "../build-intelligence/run-llm-audit.js";
import {
  CompetitiveLandscapeInputInvalidError,
  CompetitiveLandscapeRefMismatchError,
  createSEOContentBlueprintWithEvidence,
  RouteSetMismatchError,
  SeoContentBlueprintBatchInvalidError,
  SeoContentBlueprintInvalidError,
} from "../build-intelligence/seo-content-blueprint.js";
import {
  ArtifactDigestConflictError,
  persistIntelligenceArtifact,
} from "../build-intelligence/store.js";
import {
  ArtifactLineageMismatchError,
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackageWithEvidence,
  PageContentContractInvalidError,
  StructuredContentRouteMismatchError,
  StructuredContentShapeError,
} from "../build-intelligence/structured-content.js";
import { createModuleLogger } from "../core/logger.js";
import { LlmOutputTruncatedError } from "../services/llm-parse.js";
import { LlmRunRecorder } from "../services/llm-run-recorder.js";
import { LlmOutputBudgetExceededError } from "../services/seo-blueprint-output-budget.js";

// Static version reads for the preflight readiness metadata. Loaded once at
// module scope; the preflight itself makes no LLM and no DataForSEO call.
// Scoped dependency package.jsons are located by walking up node_modules —
// their exports maps do not expose "./package.json" (and may lack a require
// condition), so module resolution alone cannot read them. The service
// version is read relative to this module, which resolves identically from
// src/ and dist/.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const scopedPkgPath = (scope: string, name: string): string => {
  let dir = moduleDir;
  for (;;) {
    const candidate = join(dir, "node_modules", scope, name, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot locate ${scope}/${name}/package.json above ${moduleDir}`);
    }
    dir = parent;
  }
};
const versionAt = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
const SERVICE_VERSION: string = versionAt(join(dirname(dirname(moduleDir)), "package.json"));
const BOT_INTEROP_VERSION: string = versionAt(scopedPkgPath("@quantum-l9", "bot-interop"));

import {
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  SerpEvidenceInvalidError,
} from "../services/dataforseo.js";

const logger = createModuleLogger("api:build-intelligence");

/**
 * Response header carrying the run id every build-intelligence response belongs
 * to. Website-Bot can also derive it itself — it is a pure function of the
 * run's own (client_id, build_id) — so the header is a convenience, not the
 * only way in.
 */
export const RUN_ID_HEADER = "x-l9-seo-run-id";

/**
 * The consumer's own id for this run, optional and never routing-relevant.
 * Website-Bot mints the run id it correlates on, so it may hand that id to
 * SEO-Bot rather than recomputing SEO-Bot's derived one; the exported audit
 * echoes it as `run_id` and keeps the derived id as `seo_run_id`.
 */
const runRefSchema = z.string().min(1).max(256).optional();

const runEvidenceQuery = z
  .object({ client_id: z.string().min(1), build_id: z.string().min(1) })
  .strict();

/* ── Request schemas (strict — reject provider/model/temperature leakage) ────── */

const marketSchema = z
  .object({
    niche: z.string().min(1),
    country: z.string().min(1),
    language: z.string().min(1),
    device: z.enum(["desktop", "mobile"]).optional(),
    location_name: z.string().min(1).optional(),
  })
  .strict();

const seedQuerySchema = z
  .object({
    query: z.string().min(1),
    intent: z.enum(["informational", "commercial", "transactional", "local"]),
    weight: z.number().positive().optional(),
  })
  .strict();

const competitiveLandscapeBody = z
  .object({
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    run_ref: runRefSchema,
    market: marketSchema,
    seed_queries: z.array(seedQuerySchema).min(1),
    desired_donor_count: z.number().int().positive().optional(),
    operator_exclusions: z.array(z.string()).optional(),
  })
  .strict();

const routeIdentitySchema = z
  .object({
    route_id: z.string().min(1),
    path: z.string().min(1),
    purpose: z.string().min(1),
    keywords: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();

const seoConfigSchema = z
  .object({
    brand_voice: z.string().optional(),
    forbidden_claims: z.array(z.string()).optional(),
    aeo_geo_enabled: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .strict();

// Incoming sealed artifacts are integrity-checked (assertIntelligenceArtifact
// Integrity), not re-derived here — so they are accepted as opaque objects and
// verified cryptographically rather than re-validated field by field.
const artifactEnvelope = z.object({}).passthrough();

// Verified business facts are the ONLY grounding a blueprint may rely on. The
// contract type pins `verified: true`; the boundary enforces it so an
// unverified fact can never reach the paid strategy path (L2-S5-001).
const contentSlotSchema = z.enum([
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
]);
const verifiedBusinessFactSchema = z
  .object({
    fact_id: z.string().min(1),
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    verified: z.literal(true),
    source_refs: z.array(z.string()),
    route_ids: z.array(z.string().min(1)).optional(),
    target_slots: z.array(contentSlotSchema).optional(),
  })
  .strict();

const firstPartyAuthoritySchema = z
  .object({
    schema: z.literal(FIRST_PARTY_AUTHORITY_SCHEMA),
    market_research: z.literal("not_requested"),
    domain_spec_digest: z.string().regex(/^[0-9a-f]{64}$/),
    donor_count: z.literal(0),
  })
  .strict();

const seoContentBlueprintBody = z
  .object({
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    run_ref: runRefSchema,
    competitive_landscape: artifactEnvelope.optional(),
    first_party_authority: firstPartyAuthoritySchema.optional(),
    routes: z.array(routeIdentitySchema).min(1),
    business_facts: z.array(verifiedBusinessFactSchema),
    seo_config: seoConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasLandscape = value.competitive_landscape !== undefined;
    const hasFirstParty = value.first_party_authority !== undefined;
    if (hasLandscape === hasFirstParty) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of competitive_landscape or first_party_authority is required",
      });
    }
  });

const structuredContentBody = z
  .object({
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    run_ref: runRefSchema,
    page_content_contract: artifactEnvelope,
    seo_content_blueprint: artifactEnvelope.optional(),
  })
  .strict();

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function badRequest(reply: FastifyReply, error: string, detail?: unknown): FastifyReply {
  return reply.status(400).send({ error, ...(detail ? { detail } : {}) });
}

/**
 * Assert an incoming object is a sealed intelligence artifact of the expected
 * type with intact lineage. Throws a plain Error (→ 400) otherwise.
 */
function requireArtifact<T extends WebsiteIntelligenceArtifact>(
  value: unknown,
  expectedType: IntelligenceArtifactType,
  clientId: string,
): T {
  const artifact = value as WebsiteIntelligenceArtifact;
  if (!artifact || typeof artifact !== "object" || artifact.artifact_type !== expectedType) {
    throw new Error(`expected a ${expectedType} artifact`);
  }
  assertIntelligenceArtifactIntegrity(artifact); // throws on hash/lineage mismatch
  if (artifact.client_id !== clientId) {
    throw new Error(
      `artifact client_id "${artifact.client_id}" does not match request client_id "${clientId}"`,
    );
  }
  return artifact as T;
}

/** Persist best-effort: storage failures never compromise the producer result. */
async function persistBestEffort(artifact: WebsiteIntelligenceArtifact): Promise<void> {
  try {
    await persistIntelligenceArtifact(artifact);
  } catch (error) {
    if (error instanceof ArtifactDigestConflictError) throw error; // real lineage violation
    logger.warn(
      {
        artifactId: artifact.artifact_id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Artifact persistence failed (best-effort); returning sealed artifact anyway",
    );
  }
}

/**
 * Open a run recorder for a request, or `null` when the request carries no
 * usable run identity. Run identity must be well formed for any evidence to be
 * attributable to a run, so a blank identity is answered as a bad request
 * rather than producing a run whose evidence cannot be addressed.
 */
function openRunRecorder(clientId: string, buildId: string): LlmRunRecorder | null {
  try {
    return new LlmRunRecorder(runIdFor(clientId, buildId));
  } catch (error) {
    if (error instanceof RunLlmAuditInvalidError) return null;
    throw error;
  }
}

/* ── Routes ──────────────────────────────────────────────────────────────────── */

export async function registerBuildIntelligenceRoutes(app: FastifyInstance): Promise<void> {
  // 0. Preflight — machine-authenticated readiness metadata. No LLM call, no
  //    DataForSEO paid call; never returns key values. Website-Bot's REDESIGN
  //    preflight consumes this before the expensive pipeline begins.
  app.get("/api/build-intelligence/preflight", async () => {
    // Reaching this handler means the machine-auth hook admitted the request,
    // which is the `contractSeen` input to the machine-auth check. Every other
    // field below is a real probe result — nothing here is a hardcoded PASS.
    const preflight = runPreflight(true);
    const report = {
      ...preflight,
      version: preflight.version === "unknown" ? SERVICE_VERSION : preflight.version,
      bot_interop_version: preflight.bot_interop_version ?? BOT_INTEROP_VERSION,
      ...(preflight.llm_router_version ? { llm_router_version: preflight.llm_router_version } : {}),
      capabilities: {
        ...preflight.capabilities,
        // Schema advertisement, not a probed capability: the audit projection
        // ships with this build, so the consumer can always discover it.
        run_llm_audit: RUN_LLM_AUDIT_SCHEMA,
      },
    };
    // The golden oracle attaches disk evidence without changing the sealed
    // artifact envelope; best-effort — a persistence failure never fails the
    // response.
    persistAuditEvidence("preflight", report);
    return report;
  });

  // 1. CompetitiveLandscape — deterministic, zero-LLM SERP ranking truth.
  app.post("/api/build-intelligence/competitive-landscape", async (request, reply) => {
    const parsed = competitiveLandscapeBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "invalid request body", parsed.error.issues);
    const recorder = openRunRecorder(parsed.data.client_id, parsed.data.build_id);
    if (!recorder) return badRequest(reply, "invalid run identity");
    try {
      const { artifact, evidence } = await createCompetitiveLandscape(parsed.data);
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
      // Ranking evidence is the producer's own measured count, recorded for the
      // run before the response is written.
      recordProviderAttempts({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
      const runId = recordCompetitiveLandscapeLeg({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        run_ref: parsed.data.run_ref,
        ranking_llm_calls: evidence.ranking_llm_calls,
        recorder,
      });
      reply.header(RUN_ID_HEADER, runId);
      logger.info(
        {
          artifactId: artifact.artifact_id,
          seedQueries: evidence.seed_query_count,
          finalQueries: evidence.final_query_count,
          expansionRounds: evidence.expansion_rounds_used,
          observations: evidence.serp_observation_count,
          qualified: evidence.qualified_candidate_count,
          unknown: evidence.unknown_candidate_count,
          excluded: evidence.excluded_candidate_count,
          donors: evidence.selected_donor_count,
          rankingLlmCalls: evidence.ranking_llm_calls,
        },
        "CompetitiveLandscape produced",
      );
      return reply.status(201).send(artifact);
    } catch (error) {
      return failLeg(reply, error, {
        leg: "competitive_landscape",
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
    } finally {
      recorder.close();
    }
  });

  // 2. SEOContentBlueprint — strategic reasoning from normalized evidence.
  app.post("/api/build-intelligence/seo-content-blueprint", async (request, reply) => {
    const parsed = seoContentBlueprintBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "invalid request body", parsed.error.issues);
    let landscape: CompetitiveLandscapeArtifact | undefined;
    if (parsed.data.competitive_landscape) {
      try {
        landscape = requireArtifact<CompetitiveLandscapeArtifact>(
          parsed.data.competitive_landscape,
          "competitive_landscape",
          parsed.data.client_id,
        );
      } catch (error) {
        return badRequest(
          reply,
          "invalid competitive_landscape artifact",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const recorder = openRunRecorder(parsed.data.client_id, parsed.data.build_id);
    if (!recorder) return badRequest(reply, "invalid run identity");
    try {
      const { artifact, evidence } = await createSEOContentBlueprintWithEvidence(
        {
          client_id: parsed.data.client_id,
          build_id: parsed.data.build_id,
          ...(landscape ? { competitive_landscape: landscape } : {}),
          ...(parsed.data.first_party_authority
            ? { first_party_authority: parsed.data.first_party_authority }
            : {}),
          routes: parsed.data.routes,
          business_facts: parsed.data.business_facts as unknown as VerifiedBusinessFact[],
          seo_config: parsed.data.seo_config,
        },
        { recorder },
      );
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
      recordProviderAttempts({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
      const runId = recordSeoContentBlueprintLeg({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        run_ref: parsed.data.run_ref,
        evidence,
        recorder,
      });
      reply.header(RUN_ID_HEADER, runId);
      return reply.status(201).send(artifact);
    } catch (error) {
      return failLeg(reply, error, {
        leg: "seo_content_blueprint",
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
    } finally {
      recorder.close();
    }
  });

  // 3. StructuredContentPackage — final prose from the PageContentContract only.
  app.post("/api/build-intelligence/structured-content", async (request, reply) => {
    const parsed = structuredContentBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "invalid request body", parsed.error.issues);
    let contract: PageContentContractArtifact;
    let blueprint: SEOContentBlueprintArtifact | undefined;
    try {
      contract = requireArtifact(
        parsed.data.page_content_contract,
        "page_content_contract",
        parsed.data.client_id,
      );
      blueprint = parsed.data.seo_content_blueprint
        ? requireArtifact<SEOContentBlueprintArtifact>(
            parsed.data.seo_content_blueprint,
            "seo_content_blueprint",
            parsed.data.client_id,
          )
        : undefined;
    } catch (error) {
      return badRequest(
        reply,
        "invalid input artifact",
        error instanceof Error ? error.message : String(error),
      );
    }
    const recorder = openRunRecorder(parsed.data.client_id, parsed.data.build_id);
    if (!recorder) return badRequest(reply, "invalid run identity");
    try {
      const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
        {
          client_id: parsed.data.client_id,
          build_id: parsed.data.build_id,
          page_content_contract: contract,
          seo_content_blueprint: blueprint,
        },
        { recorder },
      );
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
      recordProviderAttempts({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
      const runId = recordStructuredContentLeg({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        run_ref: parsed.data.run_ref,
        evidence,
        recorder,
      });
      reply.header(RUN_ID_HEADER, runId);
      return reply.status(201).send(artifact);
    } catch (error) {
      return failLeg(reply, error, {
        leg: "structured_content",
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        recorder,
      });
    } finally {
      recorder.close();
    }
  });

  // 5. Router-log audit. Build-intelligence producers call DeepSeek directly and
  //    record those calls on the request recorder, not on this router singleton.
  app.get("/api/build-intelligence/llm-audit", async (request, reply) => {
    const query = request.query as { client_id?: string };
    const clientId = query.client_id?.trim() ? query.client_id : undefined;
    const projection = projectLlmAudit(recordedCallsForAudit(clientId));
    persistAuditEvidence("llm-audit", projection);
    return reply.status(200).send(projection);
  });

  // 6. Run evidence — the deterministic `l9.seo-bot-run-llm-audit/v1` surface.
  //    Same machine auth as the producers; no LLM call, no paid provider call.
  //    Production evidence retrieval goes through here, never through the
  //    offline seam-proof script.
  app.get("/api/build-intelligence/run-evidence/:run_id", async (request, reply) => {
    const { run_id: runId } = request.params as { run_id: string };
    return sendRunEvidence(reply, () => getRunLlmAudit(runId), runId);
  });

  // 7. Provider attempts — one receipt per provider attempt of the run,
  //    failed legs included, with spend equal to the sum of the receipts.
  //    Addressable by run id (every typed failure body carries it) or by the
  //    run's own (client_id, build_id), so a caller that only kept the build
  //    id can still find the attempts of a failed run.
  app.get("/api/build-intelligence/run-evidence/:run_id/provider-attempts", (request, reply) => {
    const { run_id: runId } = request.params as { run_id: string };
    return sendProviderAttempts(reply, runId);
  });

  app.get("/api/build-intelligence/run-evidence/provider-attempts", (request, reply) => {
    const parsed = runEvidenceQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "invalid request query", parsed.error.issues);
    return sendProviderAttempts(reply, runIdFor(parsed.data.client_id, parsed.data.build_id));
  });

  app.get("/api/build-intelligence/run-evidence", async (request, reply) => {
    const parsed = runEvidenceQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "invalid request query", parsed.error.issues);
    const runId = runIdFor(parsed.data.client_id, parsed.data.build_id);
    return sendRunEvidence(
      reply,
      () => getRunLlmAuditFor(parsed.data.client_id, parsed.data.build_id),
      runId,
    );
  });

  logger.info(
    "Build-intelligence routes registered (competitive-landscape, seo-content-blueprint, structured-content, preflight, llm-audit, run-evidence)",
  );
}

/**
/**
 * Persist audit/preflight evidence under `.l9/build-intelligence/` (gitignored)
 * so the golden oracle can attach disk evidence without changing the sealed
 * artifact envelope that Website-Bot consumes. Best-effort: a persistence
 * failure never fails the response.
 */
function persistAuditEvidence(kind: "preflight" | "llm-audit", value: unknown): void {
  try {
    const dir = path.join(process.cwd(), ".l9", "build-intelligence");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(
      path.join(dir, `${kind}-${stamp}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    logger.warn(
      { kind, error: error instanceof Error ? error.message : String(error) },
      "Failed to persist audit evidence to disk (best-effort)",
    );
  }
}

/**
 * Return a run's audit, or the exact reason it cannot be returned. Evidence
 * that fails its own fail-closed validation surfaces as 422 with the violation
 * list — a self-contradicting run is never answered with a plausible document.
 */
function sendRunEvidence(
  reply: FastifyReply,
  load: () => ReturnType<typeof getRunLlmAudit>,
  runId: string,
): FastifyReply {
  let audit: ReturnType<typeof getRunLlmAudit>;
  try {
    audit = load();
  } catch (error) {
    if (error instanceof RunLlmAuditInvalidError) {
      logger.error({ runId, violations: error.violations }, "Run LLM audit failed validation");
      return reply
        .status(422)
        .send({ error: error.code, message: error.message, violations: error.violations });
    }
    throw error;
  }
  if (!audit) {
    return reply
      .status(404)
      .send({ error: "RUN_EVIDENCE_NOT_FOUND", message: `no run evidence for ${runId}` });
  }
  reply.header(RUN_ID_HEADER, audit.run_id);
  return reply.status(200).send(audit);
}

/** Where a run's provider attempts can be read. */
function providerAttemptsPath(runId: string): string {
  return `/api/build-intelligence/run-evidence/${encodeURIComponent(runId)}/provider-attempts`;
}

/** A run's provider attempts, or the exact reason they cannot be returned. */
function sendProviderAttempts(reply: FastifyReply, runId: string): FastifyReply {
  let document: ReturnType<typeof getRunProviderAttempts>;
  try {
    document = getRunProviderAttempts(runId);
  } catch (error) {
    if (error instanceof ProviderAttemptsInvalidError) {
      logger.error({ runId, violations: error.violations }, "Provider attempts failed validation");
      return reply
        .status(422)
        .send({ error: error.code, message: error.message, violations: error.violations });
    }
    throw error;
  }
  if (!document) {
    return reply.status(404).send({
      error: "RUN_EVIDENCE_NOT_FOUND",
      message: `no ${PROVIDER_ATTEMPTS_SCHEMA} evidence for ${runId}`,
    });
  }
  reply.header(RUN_ID_HEADER, document.run_id);
  return reply.status(200).send(document);
}

/**
 * Record a failed leg's provider attempts and the typed failure that ended it,
 * then answer with that failure. The attempts the leg spent are evidence
 * whether or not the leg succeeded.
 */
function failLeg(
  reply: FastifyReply,
  error: unknown,
  leg: {
    leg: ProviderLegFailure["leg"];
    client_id: string;
    build_id: string;
    recorder: LlmRunRecorder;
  },
): FastifyReply {
  const failure = classifyProducerError(error, leg.recorder);
  // The run id travels in the body too: a caller that keeps only bodies (not
  // headers) must still be able to fetch this failed run's provider attempts.
  const runId = runIdFor(leg.client_id, leg.build_id);
  reply.header(RUN_ID_HEADER, runId);
  try {
    recordProviderAttempts({
      client_id: leg.client_id,
      build_id: leg.build_id,
      recorder: leg.recorder,
      failure: {
        leg: leg.leg,
        code: String(failure.body.error),
        operation: (failure.body.operation as string | undefined) ?? null,
        batch: (failure.body.batch as string | null | undefined) ?? null,
      },
    });
  } catch (recordError) {
    // Recording evidence never replaces the producer's own failure.
    logger.error(
      { error: recordError instanceof Error ? recordError.message : String(recordError) },
      "Failed to record provider attempts for a failed leg",
    );
  }
  return reply.status(failure.status).send({
    ...failure.body,
    run_id: runId,
    provider_attempts: providerAttemptsPath(runId),
  });
}

/** Where a provider failure happened, as response fields. */
function siteFields(site: ProviderFailureSite | null | undefined): Record<string, unknown> {
  if (!site) return {};
  return {
    operation: site.operation,
    batch: site.batch,
    attempt: site.attempt,
  };
}

interface ProducerFailure {
  status: number;
  body: Record<string, unknown>;
}

function failure(status: number, body: Record<string, unknown>): ProducerFailure {
  return { status, body };
}

/**
 * Classify a producer failure into a stable HTTP status and a typed body. A
 * producer failure is NEVER answered with a fabricated success: every branch
 * here is a 4xx/5xx. Provider failures carry the failing operation and batch.
 */
function classifyProducerError(error: unknown, recorder: LlmRunRecorder): ProducerFailure {
  const last = recorder.lastProviderAttempt();
  const lastSite: ProviderFailureSite | null = last
    ? { operation: last.operation, purpose: last.purpose, batch: last.batch, attempt: last.attempt }
    : null;
  // Provider stopped at its output cap. Never repaired. The body carries
  // measurements only, never model output.
  if (error instanceof DeepSeekOutputTruncatedError) {
    return {
      status: 502,
      body: {
        error: error.code,
        message: error.message,
        ...siteFields(error.site),
        policy: error.policy,
        finish_reason: error.finishReason,
        max_tokens: error.maxOutputTokens,
        completion_tokens: error.outputTokens,
        prompt_tokens: error.promptTokens,
        reasoning_tokens: error.reasoningTokens,
      },
    };
  }
  if (error instanceof DeepSeekTransportError) {
    return {
      status: 502,
      body: { error: error.code, message: error.message, ...siteFields(error.site) },
    };
  }
  if (error instanceof BudgetExhaustedError) {
    return {
      status: 402,
      body: { error: error.code, message: error.message, ...siteFields(error.site) },
    };
  }
  if (error instanceof ProviderRequestError || error instanceof TaskValidationError) {
    return {
      status: 503,
      body: { error: error.code, message: error.message, ...siteFields(error.site) },
    };
  }
  if (error instanceof SeoContentBlueprintBatchInvalidError) {
    return {
      status: 422,
      body: { error: error.code, message: error.message, ...siteFields(lastSite) },
    };
  }
  const legacy = typedProducerFailure(error);
  if (legacy) return legacy;
  const message = error instanceof Error ? error.message : String(error);
  // The last provider reply was rejected by its validator and the producer
  // failed on it: a schema failure, after the bounded repair when the last
  // attempt was the repair. Read from the attempt receipt, not guessed from
  // the message.
  if (last?.outcome === "SCHEMA_INVALID") {
    return {
      status: 422,
      body: {
        error: last.attempt === "repair" ? "LLM_SCHEMA_INVALID_AFTER_REPAIR" : "LLM_SCHEMA_INVALID",
        message,
        ...siteFields(lastSite),
      },
    };
  }
  logger.error({ error: message }, "Build-intelligence producer failed");
  return {
    status: 500,
    body: { error: "build_intelligence_failed", message, ...siteFields(lastSite) },
  };
}

/**
 * Map typed non-provider producer failures to stable HTTP statuses and bodies,
 * or null for an error this function does not recognise.
 */
function typedProducerFailure(error: unknown): ProducerFailure | null {
  // Upstream evidence provider is unreachable or refused the request.
  if (error instanceof DataForSeoUnavailableError) {
    return failure(502, { error: error.code, message: error.message });
  }
  if (error instanceof DeepSeekTransportError) {
    return failure(502, { error: error.code, message: error.message });
  }
  // Provider reached, individual task failed, or its payload is unusable.
  if (error instanceof DataForSeoTaskError || error instanceof SerpEvidenceInvalidError) {
    return failure(502, { error: error.code, message: error.message });
  }
  // The upstream model stopped at its output cap: the reply is unusable, so
  // this is a bad upstream response, not a server fault. The message carries
  // measurements only (operation, purpose, cap, finish reason) — never output.
  if (error instanceof LlmOutputTruncatedError) {
    return failure(502, { error: error.code, message: error.message });
  }
  // The request needs more output than the governed ceiling allows. Raised
  // before any LLM call; the request as sized cannot be served.
  if (error instanceof LlmOutputBudgetExceededError) {
    return failure(422, { error: error.code, message: error.message });
  }
  if (error instanceof CompetitiveEvidenceIncompleteError) {
    return failure(422, { error: error.code, message: error.message, detail: error.detail });
  }
  if (error instanceof CompetitiveDonorQualificationError) {
    return failure(422, { error: error.code, message: error.message, detail: error.detail });
  }
  if (
    error instanceof CompetitiveLandscapeInvalidError ||
    error instanceof CompetitiveLandscapeInputInvalidError
  ) {
    return failure(422, { error: error.code, message: error.message });
  }
  if (
    error instanceof RouteSetMismatchError ||
    error instanceof SeoContentBlueprintInvalidError ||
    error instanceof CompetitiveLandscapeRefMismatchError ||
    error instanceof PageContentContractInvalidError ||
    error instanceof StructuredContentRouteMismatchError ||
    error instanceof ArtifactLineageMismatchError
  ) {
    return failure(422, { error: error.code, message: error.message });
  }
  if (error instanceof ContentRequirementUnsatisfiedError) {
    return failure(422, {
      error: error.code,
      message: error.message,
      failed_requirements: error.failedRequirements,
      unsupported_claims: error.unsupportedClaims,
    });
  }
  if (error instanceof StructuredContentShapeError) {
    return failure(422, { error: error.code, message: error.message });
  }
  if (error instanceof ArtifactDigestConflictError) {
    return failure(409, { error: error.code, message: error.message });
  }
  // Lineage assertion failures from bot-interop surface as INTEL_ARTIFACT_*.
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("INTEL_ARTIFACT_")) {
    return failure(422, { error: "INTEL_ARTIFACT_INTEGRITY", message });
  }
  return null;
}
