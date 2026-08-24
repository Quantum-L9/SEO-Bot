/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 3 — SEOContentBlueprint (strategic reasoning, NO search routing)
 *
 * Consumes CompetitiveLandscape + route identities/purposes + VerifiedBusiness
 * Facts + SEO config. It deliberately does NOT consume WebsiteBuildBlueprint —
 * that preserves SEO-Bot's independent authority over the content strategy.
 *
 * Evidence is normalized BEFORE the model: bounded, deterministic page-content
 * metrics for relevant donor ranking URLs only — never raw HTML, never a
 * full-site crawl. The model performs strategic reasoning (requiresSearch=false)
 * and decides search intent, topics, entities, questions, gaps, requirements,
 * internal-link/AEO/metadata requirements, forbidden claims, acceptance tests.
 * It does NOT decide layout, section order, component classes, or final prose —
 * the shared SEOContentBlueprintV1 contract has no such fields.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
  refForArtifact,
  type SEOContentBlueprintArtifact,
  type SEOContentBlueprintRoute,
  type SEOContentBlueprintV1,
  sameArtifactRef,
  sealIntelligenceArtifact,
  type VerifiedBusinessFact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { DataForSeoClient } from "../services/dataforseo.js";
import { getLlmService, type LlmService } from "../services/llm.js";
import { PRODUCER } from "./producer.js";
import { seoContentBlueprintRoutesSchema } from "./schema-guards.js";

const logger = createModuleLogger("build-intelligence:seo-content-blueprint");

/** Bounded, deterministic page-content metrics surface (injectable for tests). */
export interface PageContentPort {
  getPageContent(url: string): Promise<{
    wordCount: number;
    headings: number;
    images: number;
    internalLinks: number;
    externalLinks: number;
  }>;
}

export interface SEOContentBlueprintRequest {
  client_id: string;
  build_id: string;
  competitive_landscape: CompetitiveLandscapeArtifact;
  routes: Array<{ route_id: string; path: string; purpose: string }>;
  business_facts: VerifiedBusinessFact[];
  seo_config?: {
    brand_voice?: string;
    forbidden_claims?: string[];
    aeo_geo_enabled?: boolean;
    notes?: string;
  };
}

/** The supplied CompetitiveLandscape is not usable as blueprint input. */
export class CompetitiveLandscapeInputInvalidError extends Error {
  readonly code = "COMPETITIVE_LANDSCAPE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CompetitiveLandscapeInputInvalidError";
  }
}

/** The requested route set is itself malformed (empty, duplicated, unusable). */
export class RouteSetMismatchError extends Error {
  readonly code = "ROUTE_SET_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "RouteSetMismatchError";
  }
}

/** Model output does not satisfy the deterministic blueprint contract. */
export class SeoContentBlueprintInvalidError extends Error {
  readonly code = "SEO_CONTENT_BLUEPRINT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "SeoContentBlueprintInvalidError";
  }
}

/** The sealed blueprint does not reference the exact landscape it consumed. */
export class CompetitiveLandscapeRefMismatchError extends Error {
  readonly code = "COMPETITIVE_LANDSCAPE_REF_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "CompetitiveLandscapeRefMismatchError";
  }
}

// Evidence bounds — capped so the model never receives an unbounded payload and
// no full-site crawl is ever performed.
const MAX_DONORS_FOR_EVIDENCE = 6;
const MAX_URLS_PER_DONOR = 1;
const MAX_TOTAL_URLS = 8;

/**
 * Deterministic blueprint batching: routes are produced in groups of this size,
 * one LLM strategize call per group. The golden oracle pins batch_size=4 and
 * batch_count=ceil(route_count/4) — for 29 routes, 8 batches.
 */
export const SEO_CONTENT_BLUEPRINT_BATCH_SIZE = 4;

interface NormalizedDonorEvidence {
  domain: string;
  aggregate_visibility: number;
  ranking_url: string;
  organic_rank: number;
  word_count: number;
  headings: number;
  images: number;
  internal_links: number;
  external_links: number;
}

export async function createSEOContentBlueprint(
  request: SEOContentBlueprintRequest,
  deps: { llm?: LlmService; dataForSeo?: PageContentPort } = {},
): Promise<SEOContentBlueprintArtifact> {
  assertRouteSet(request.routes);
  assertLandscapeUsable(request.competitive_landscape);

  const llm = deps.llm ?? getLlmService();
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const landscape = request.competitive_landscape.payload;

  const evidence = await gatherDonorEvidence(landscape, dataForSeo);

  // ── Deterministic batching (oracle: batch_size=4, batch_count=ceil(n/4)) ──────
  const batchSize = SEO_CONTENT_BLUEPRINT_BATCH_SIZE;
  const batches = chunkRoutes(request.routes, batchSize);
  const batchCount = batches.length;
  if (batchCount !== Math.ceil(request.routes.length / batchSize)) {
    throw new SeoContentBlueprintInvalidError(
      `batch_count=${batchCount} does not match ceil(route_count=${request.routes.length}/${batchSize})`,
    );
  }
  if (batchCount === 0) {
    throw new RouteSetMismatchError("at least one route identity is required");
  }

  const systemPrompt =
    "You are a senior SEO content strategist. You produce a STRATEGIC content " +
    "blueprint from normalized competitive evidence and verified business facts. " +
    "You decide search intent, supporting queries, topics, entities, questions, " +
    "competitive content gaps, content requirements, internal-link requirements, " +
    "AEO/GEO requirements, metadata requirements, forbidden claims, and acceptance " +
    "tests. You do NOT decide page layout, section order, component classes, visual " +
    "design, CTA placement, or final prose. You are producing ONE BATCH of a " +
    "multi-batch blueprint: return exactly the requested routes of this batch and " +
    "no others (other batches are produced separately). Respond with ONLY a JSON " +
    'object {"routes":[...]} — no markdown fences, no commentary.';

  // Every batch may declare internal links to ANY site route — including routes
  // produced in other batches — so the full route id list is always available.
  const allRouteIds = request.routes.map((route) => route.route_id);

  const produced: SEOContentBlueprintRoute[][] = [];
  for (const batch of batches) {
    const userPrompt = buildBatchPrompt(landscape, evidence, request, batch, allRouteIds);
    const batchRoutes = await llm.strategizeJson<SEOContentBlueprintRoute[]>({
      clientId: request.client_id,
      module: "build-intelligence",
      purpose: `seo-content-blueprint:${request.build_id}`,
      systemPrompt,
      userPrompt,
      validate: (value) => reconcileBatchRoutes(value, batch),
    });
    produced.push(batchRoutes);
  }

  const routes = reconcileGlobalRoutes(produced, request.routes);

  const landscapeRef = refForArtifact(request.competitive_landscape);
  const payload: SEOContentBlueprintV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
    competitive_landscape_ref: landscapeRef,
    batch_size: batchSize,
    batch_count: batchCount,
    routes,
  };

  // Exact lineage, proven rather than assumed: the sealed blueprint must point
  // at precisely the landscape artifact this call consumed.
  if (!sameArtifactRef(payload.competitive_landscape_ref, landscapeRef)) {
    throw new CompetitiveLandscapeRefMismatchError(
      "Sealed blueprint does not reference the exact CompetitiveLandscape supplied in the request",
    );
  }

  const artifact = sealIntelligenceArtifact({
    artifact_type: "seo_content_blueprint",
    client_id: request.client_id,
    build_id: request.build_id,
    producer: PRODUCER,
    input_refs: [landscapeRef],
    payload,
  });

  logger.info(
    {
      clientId: request.client_id,
      buildId: request.build_id,
      routes: routes.length,
      competitiveLandscapeRef: payload.competitive_landscape_ref.artifact_id,
      artifactId: artifact.artifact_id,
    },
    "SEOContentBlueprint sealed",
  );

  return artifact;
}

/** The requested route set is the identity authority — it must be well formed. */
function assertRouteSet(routes: SEOContentBlueprintRequest["routes"]): void {
  if (routes.length === 0) {
    throw new RouteSetMismatchError("at least one route identity is required");
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const route of routes) {
    if (seenIds.has(route.route_id)) {
      throw new RouteSetMismatchError(
        `duplicate route_id in requested route set: ${route.route_id}`,
      );
    }
    if (seenPaths.has(route.path)) {
      throw new RouteSetMismatchError(`duplicate path in requested route set: ${route.path}`);
    }
    seenIds.add(route.route_id);
    seenPaths.add(route.path);
  }
}

/**
 * A blueprint may only be built on a landscape that is intact AND complete.
 * Building strategy on an incomplete donor cohort is exactly the failure mode
 * this producer exists to prevent.
 */
function assertLandscapeUsable(landscape: CompetitiveLandscapeArtifact): void {
  assertIntelligenceArtifactIntegrity(landscape);
  if (landscape.artifact_type !== "competitive_landscape") {
    throw new CompetitiveLandscapeInputInvalidError(
      `expected a competitive_landscape artifact, received ${landscape.artifact_type}`,
    );
  }
  if (landscape.payload.schema !== WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape) {
    throw new CompetitiveLandscapeInputInvalidError(
      `unexpected CompetitiveLandscape payload schema: ${landscape.payload.schema}`,
    );
  }
  if (!landscape.payload.evidence_complete) {
    throw new CompetitiveLandscapeInputInvalidError(
      "CompetitiveLandscape is not evidence_complete; refusing to build a blueprint on partial competitive intelligence",
    );
  }
  if (landscape.payload.selected_donors.length === 0) {
    throw new CompetitiveLandscapeInputInvalidError("CompetitiveLandscape has no selected donors");
  }
  if (landscape.payload.observations.length === 0) {
    throw new CompetitiveLandscapeInputInvalidError(
      "CompetitiveLandscape has no SERP observations",
    );
  }
}

/**
 * Deterministic, bounded page-content evidence for the top donors. Pulls only
 * donor ranking URLs (from the landscape observations), dedupes identical URLs,
 * caps per-donor and total, and surfaces numeric metrics only — never raw HTML.
 * Individual fetch failures degrade gracefully (that donor contributes no
 * metrics) so evidence gathering never fails the whole blueprint.
 */
async function gatherDonorEvidence(
  landscape: CompetitiveLandscapeArtifact["payload"],
  dataForSeo: PageContentPort,
): Promise<NormalizedDonorEvidence[]> {
  const observationById = new Map(landscape.observations.map((obs) => [obs.observation_id, obs]));
  const evidence: NormalizedDonorEvidence[] = [];
  const seenUrls = new Set<string>();

  for (const donor of landscape.selected_donors.slice(0, MAX_DONORS_FOR_EVIDENCE)) {
    if (evidence.length >= MAX_TOTAL_URLS) break;
    const donorObservations = donor.observation_ids
      .map((id) => observationById.get(id))
      .filter((obs): obs is NonNullable<typeof obs> => Boolean(obs))
      .sort((a, b) => a.rank - b.rank);
    await collectDonorMetrics(donor, donorObservations, dataForSeo, seenUrls, evidence);
  }
  return evidence;
}

/**
 * Pull page-content metrics for one donor's ranked URLs, honoring the
 * per-donor and total URL caps. Individual fetch failures are skipped with a
 * warning so evidence gathering never fails the whole blueprint.
 */
async function collectDonorMetrics(
  donor: CompetitiveLandscapeArtifact["payload"]["selected_donors"][number],
  donorObservations: Array<{ url: string; rank: number }>,
  dataForSeo: PageContentPort,
  seenUrls: Set<string>,
  evidence: NormalizedDonorEvidence[],
): Promise<void> {
  let perDonor = 0;
  for (const obs of donorObservations) {
    if (perDonor >= MAX_URLS_PER_DONOR || evidence.length >= MAX_TOTAL_URLS) break;
    if (seenUrls.has(obs.url)) continue;
    seenUrls.add(obs.url);
    perDonor += 1;
    try {
      const metrics = await dataForSeo.getPageContent(obs.url);
      evidence.push({
        domain: donor.domain,
        aggregate_visibility: donor.aggregate_visibility,
        ranking_url: obs.url,
        organic_rank: obs.rank,
        word_count: metrics.wordCount,
        headings: metrics.headings,
        images: metrics.images,
        internal_links: metrics.internalLinks,
        external_links: metrics.externalLinks,
      });
    } catch (error) {
      logger.warn(
        { url: obs.url, error: error instanceof Error ? error.message : String(error) },
        "Donor page-content pull failed; skipping this URL",
      );
    }
  }
}

/**
 * Deterministic route grouping: consecutive runs of `batchSize`, final batch
 * possibly smaller. Route order is preserved within each batch.
 */
function chunkRoutes<T>(routes: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < routes.length; i += batchSize) {
    batches.push(routes.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * One batch's prompt. The batch's routes are the identity authority (the model
 * must return exactly those), but the FULL route id list is the internal-link
 * vocabulary — links may target routes produced in other batches.
 */
function buildBatchPrompt(
  landscape: CompetitiveLandscapeArtifact["payload"],
  evidence: NormalizedDonorEvidence[],
  request: SEOContentBlueprintRequest,
  batch: SEOContentBlueprintRequest["routes"],
  allRouteIds: string[],
): string {
  return JSON.stringify(
    {
      market: landscape.market,
      query_portfolio: landscape.query_portfolio,
      selected_donors: landscape.selected_donors,
      normalized_donor_evidence: evidence,
      routes: batch,
      verified_business_facts: request.business_facts,
      seo_config: request.seo_config ?? {},
      output_contract: {
        one_entry_per_route_id: batch.map((route) => route.route_id),
        route_shape: {
          route_id: "the route id exactly as given (string)",
          path: "the route path exactly as given (string)",
          search_intent: {
            primary: "primary search intent (string)",
            secondary: "string[]",
            journey_stage: "one of: informational | commercial | transactional",
          },
          targets: {
            primary_query: "string",
            supporting_queries: "string[]",
            topics: "string[]",
            entities: "string[]",
          },
          requirements: [
            {
              requirement_id: "string",
              target_slots: "content slot names (string[])",
              placement: "one of: FIRST_MATCH | ALL_MATCHES",
              required_topics: "string[]",
              required_entities: "string[]",
              questions: "string[]",
              proof_needed: "string[]",
              required: "boolean",
            },
          ],
          competitive_gaps: [
            {
              gap_id: "string",
              description: "string",
              donor_domains: "string[]",
              opportunity: "string",
            },
          ],
          internal_links: [
            {
              target_route_id:
                `string (must be one of the site route ids: ${allRouteIds.join(", ")})`,
              purpose: "string",
            },
          ],
          aeo_geo: { answer_targets: "string[]", schema_requirements: "string[]" },
          metadata: { title_requirements: "string[]", description_requirements: "string[]" },
          forbidden_claims: "string[]",
          acceptance_tests: "string[]",
        },
        content_slots: [
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
        ],
        note:
          "Return exactly one route object per route_id above, matching route_shape exactly. " +
          "Do not add layout, component, or prose fields.",
      },
    },
    null,
    2,
  );
}

/**
 * Validate one batch's model output against the shared route schema and
 * reconcile it with the REQUESTED route identities of that batch. Route
 * identity (route_id + path) is an input, not the model's to invent or change
 * — so identities are re-asserted from the request and routes are returned in
 * the requested order (deterministic). Missing or unexpected routes throw,
 * triggering the single bounded repair. Cross-batch semantic checks (internal
 * links) happen in the global reconcile.
 */
function reconcileBatchRoutes(
  value: unknown,
  batch: Array<{ route_id: string; path: string; purpose: string }>,
): SEOContentBlueprintRoute[] {
  // Slot vocabulary is enforced here: `target_slots` is a zod enum over the
  // shared ContentSlot union, so an invented slot name fails the parse.
  const parsed = seoContentBlueprintRoutesSchema.parse(value);
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));

  if (byId.size !== parsed.routes.length) {
    throw new Error("Duplicate route_id in model output");
  }

  const batchIds = new Set(batch.map((route) => route.route_id));
  const unexpected = parsed.routes
    .map((route) => route.route_id)
    .filter((id) => !batchIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected route_id(s) not in this batch's requested set: ${unexpected.join(", ")}`,
    );
  }

  return batch.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new Error(`Missing blueprint for required route_id: ${route.route_id}`);
    }
    // Re-assert identity from the request (authority), keep strategic fields.
    return { ...produced, route_id: route.route_id, path: route.path };
  });
}

/**
 * Reconcile all produced batches against the FULL requested route set and
 * enforce deterministic semantic checks across batches (internal links may
 * target routes produced in any batch, so semantics cannot run per batch).
 * Returns routes in requested order. Missing or unexpected routes throw.
 */
function reconcileGlobalRoutes(
  produced: SEOContentBlueprintRoute[][],
  requested: Array<{ route_id: string; path: string; purpose: string }>,
): SEOContentBlueprintRoute[] {
  const flattened = produced.flat();
  const byId = new Map(flattened.map((route) => [route.route_id, route]));
  if (byId.size !== flattened.length) {
    throw new Error("Duplicate route_id across batches");
  }

  const requestedIds = new Set(requested.map((route) => route.route_id));
  for (const id of byId.keys()) {
    if (!requestedIds.has(id)) {
      throw new Error(`Unexpected route_id(s) not in the requested set: ${id}`);
    }
  }

  const routes = requested.map((route) => {
    const producedRoute = byId.get(route.route_id);
    if (!producedRoute) {
      throw new Error(`Missing blueprint for required route_id: ${route.route_id}`);
    }
    return producedRoute;
  });

  assertBlueprintSemantics(routes, requestedIds);
  return routes;
}

/**
 * Deterministic semantic checks the zod shape cannot express: internal links
 * must target routes that exist, and requirement ids must be unique per route.
 * A violation throws, which triggers the single bounded repair before sealing.
 */
function assertBlueprintSemantics(
  routes: SEOContentBlueprintRoute[],
  requestedIds: Set<string>,
): void {
  for (const route of routes) {
    for (const link of route.internal_links) {
      if (!requestedIds.has(link.target_route_id)) {
        throw new Error(
          `Route "${route.route_id}" links to unknown target_route_id "${link.target_route_id}"`,
        );
      }
      if (link.target_route_id === route.route_id) {
        throw new Error(`Route "${route.route_id}" links to itself`);
      }
    }
    const requirementIds = new Set<string>();
    for (const requirement of route.requirements) {
      if (requirementIds.has(requirement.requirement_id)) {
        throw new Error(
          `Route "${route.route_id}" has duplicate requirement_id "${requirement.requirement_id}"`,
        );
      }
      requirementIds.add(requirement.requirement_id);
      if (requirement.target_slots.length === 0) {
        throw new Error(
          `Route "${route.route_id}" requirement "${requirement.requirement_id}" targets no content slot`,
        );
      }
    }
  }
}
