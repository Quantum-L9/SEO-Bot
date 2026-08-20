/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 8 — Build-time intelligence API (l9.website-intelligence/v1 seam)
 *
 * Three direct HTTP endpoints on the existing Fastify surface (no second HTTP
 * server). Website-Bot is the named consumer. Operator auth + rate limiting are
 * applied by the shared onRequest hooks in api/security.ts — these routes are
 * NOT auth-exempt.
 *
 * Every endpoint: validate request → invoke owned service → validate resulting
 * artifact → persist (best-effort) → return the sealed artifact.
 *
 * PROVIDER/MODEL NEVER LEAK: request bodies are `.strict()`, so `provider`,
 * `model`, `temperature`, Perplexity/OpenRouter flags, or a raw system prompt
 * are rejected at the schema boundary (400) rather than reaching routing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
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
  CompetitiveLandscapeInputInvalidError,
  CompetitiveLandscapeRefMismatchError,
  createSEOContentBlueprint,
  RouteSetMismatchError,
  SeoContentBlueprintInvalidError,
} from "../build-intelligence/seo-content-blueprint.js";
import {
  ArtifactDigestConflictError,
  persistIntelligenceArtifact,
} from "../build-intelligence/store.js";
import {
  ArtifactLineageMismatchError,
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackage,
  PageContentContractInvalidError,
  StructuredContentRouteMismatchError,
} from "../build-intelligence/structured-content.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModuleLogger } from "../core/logger.js";

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
const LLM_ROUTER_VERSION: string = versionAt(scopedPkgPath("@quantum-l9", "llm-router"));
import {
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  SerpEvidenceInvalidError,
} from "../services/dataforseo.js";

const logger = createModuleLogger("api:build-intelligence");

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

const seoContentBlueprintBody = z
  .object({
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    competitive_landscape: artifactEnvelope,
    routes: z.array(routeIdentitySchema).min(1),
    business_facts: z.array(z.object({}).passthrough()),
    seo_config: seoConfigSchema.optional(),
  })
  .strict();

const structuredContentBody = z
  .object({
    client_id: z.string().min(1),
    build_id: z.string().min(1),
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

/* ── Routes ──────────────────────────────────────────────────────────────────── */

export async function registerBuildIntelligenceRoutes(app: FastifyInstance): Promise<void> {
  // 0. Preflight — machine-authenticated readiness metadata. No LLM call, no
  //    DataForSEO paid call; never returns key values. Website-Bot's REDESIGN
  //    preflight consumes this before the expensive pipeline begins.
  app.get("/api/build-intelligence/preflight", async () => {
    const dataforseoConfigured = Boolean(
      process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD,
    );
    const llmConfigured = Boolean(
      process.env.OPENROUTER_API_KEY && process.env.PERPLEXITY_API_KEY,
    );
    return {
      status: "ready",
      service: "SEO-Bot",
      version: SERVICE_VERSION,
      bot_interop_version: BOT_INTEROP_VERSION,
      llm_router_version: LLM_ROUTER_VERSION,
      capabilities: {
        competitive_landscape: true,
        seo_content_blueprint: true,
        structured_content: true,
      },
      configuration: {
        dataforseo_configured: dataforseoConfigured,
        llm_provider_configured: llmConfigured,
      },
    };
  });

  // 1. CompetitiveLandscape — deterministic, zero-LLM SERP ranking truth.
  app.post("/api/build-intelligence/competitive-landscape", async (request, reply) => {
    const parsed = competitiveLandscapeBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "invalid request body", parsed.error.issues);
    try {
      const { artifact, evidence } = await createCompetitiveLandscape(parsed.data);
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
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
      return handleProducerError(reply, error);
    }
  });

  // 2. SEOContentBlueprint — strategic reasoning from normalized evidence.
  app.post("/api/build-intelligence/seo-content-blueprint", async (request, reply) => {
    const parsed = seoContentBlueprintBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "invalid request body", parsed.error.issues);
    let landscape: CompetitiveLandscapeArtifact;
    try {
      landscape = requireArtifact(
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
    try {
      const artifact = await createSEOContentBlueprint({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        competitive_landscape: landscape,
        routes: parsed.data.routes,
        business_facts: parsed.data.business_facts as unknown as VerifiedBusinessFact[],
        seo_config: parsed.data.seo_config,
      });
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
      return reply.status(201).send(artifact);
    } catch (error) {
      return handleProducerError(reply, error);
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
    try {
      const artifact = await createStructuredContentPackage({
        client_id: parsed.data.client_id,
        build_id: parsed.data.build_id,
        page_content_contract: contract,
        seo_content_blueprint: blueprint,
      });
      assertIntelligenceArtifactIntegrity(artifact);
      await persistBestEffort(artifact);
      return reply.status(201).send(artifact);
    } catch (error) {
      return handleProducerError(reply, error);
    }
  });

  logger.info(
    "Build-intelligence routes registered (competitive-landscape, seo-content-blueprint, structured-content)",
  );
}

/**
 * Map typed producer failures to stable HTTP responses. A producer failure is
 * NEVER answered with a fabricated success — every branch here is a 4xx/5xx.
 */
function handleProducerError(reply: FastifyReply, error: unknown): FastifyReply {
  // Upstream evidence provider is unreachable or refused the request.
  if (error instanceof DataForSeoUnavailableError) {
    return reply.status(502).send({ error: error.code, message: error.message });
  }
  // Provider reached, individual task failed, or its payload is unusable.
  if (error instanceof DataForSeoTaskError || error instanceof SerpEvidenceInvalidError) {
    return reply.status(502).send({ error: error.code, message: error.message });
  }
  if (error instanceof CompetitiveEvidenceIncompleteError) {
    return reply
      .status(422)
      .send({ error: error.code, message: error.message, detail: error.detail });
  }
  if (error instanceof CompetitiveDonorQualificationError) {
    return reply
      .status(422)
      .send({ error: error.code, message: error.message, detail: error.detail });
  }
  if (
    error instanceof CompetitiveLandscapeInvalidError ||
    error instanceof CompetitiveLandscapeInputInvalidError
  ) {
    return reply.status(422).send({ error: error.code, message: error.message });
  }
  if (
    error instanceof RouteSetMismatchError ||
    error instanceof SeoContentBlueprintInvalidError ||
    error instanceof CompetitiveLandscapeRefMismatchError ||
    error instanceof PageContentContractInvalidError ||
    error instanceof StructuredContentRouteMismatchError ||
    error instanceof ArtifactLineageMismatchError
  ) {
    return reply.status(422).send({ error: error.code, message: error.message });
  }
  if (error instanceof ContentRequirementUnsatisfiedError) {
    return reply.status(422).send({
      error: error.code,
      message: error.message,
      failed_requirements: error.failedRequirements,
      unsupported_claims: error.unsupportedClaims,
    });
  }
  if (error instanceof ArtifactDigestConflictError) {
    return reply.status(409).send({ error: error.code, message: error.message });
  }
  // Lineage assertion failures from bot-interop surface as INTEL_ARTIFACT_*.
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("INTEL_ARTIFACT_")) {
    return reply.status(422).send({ error: "INTEL_ARTIFACT_INTEGRITY", message });
  }
  logger.error({ error: message }, "Build-intelligence producer failed");
  return reply.status(500).send({ error: "build_intelligence_failed", message });
}
