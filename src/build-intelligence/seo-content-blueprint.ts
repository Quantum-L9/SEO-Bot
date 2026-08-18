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
import {
  type GlobalRouteIntentRoute,
  globalRouteIntentSchema,
  seoContentBlueprintRoutesSchema,
} from "./schema-guards.js";

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
 * Deterministic batch size for full blueprint generation. Safe Haven's 29
 * routes yield 8 batches: 4 + 4 + 4 + 4 + 4 + 4 + 4 + 1. Batch composition
 * always derives from request.routes order — never from model output.
 */
export const SEO_BLUEPRINT_BATCH_SIZE = 4;

export function chunkRoutes<T>(routes: T[], size = SEO_BLUEPRINT_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < routes.length; i += size) {
    result.push(routes.slice(i, i + size));
  }
  return result;
}

/**
 * Measured evidence about a batched blueprint run, sibling to the plain
 * artifact endpoint (mirrors StructuredContent's evidence shape).
 */
export interface SEOContentBlueprintEvidence {
  route_count: number;
  batch_size: number;
  batch_count: number;
  completed_batches: number;
  missing_route_ids: string[];
  extra_route_ids: string[];
}

export interface SEOContentBlueprintResult {
  artifact: SEOContentBlueprintArtifact;
  evidence: SEOContentBlueprintEvidence;
}

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
  return (await createSEOContentBlueprintWithEvidence(request, deps)).artifact;
}

/**
 * Batched blueprint generation: compact global route strategy → deterministic
 * batches (4 routes, request order) → batch-scoped reconciliation →
 * deterministic whole-site merge → whole-site semantic checks → seal.
 * The single-batch fast path (route count ≤ batch size) skips the global plan
 * call — a separate global strategy adds no cross-batch coordination there —
 * and keeps exactly one strategic call for the whole site.
 */
export async function createSEOContentBlueprintWithEvidence(
  request: SEOContentBlueprintRequest,
  deps: { llm?: LlmService; dataForSeo?: PageContentPort } = {},
): Promise<SEOContentBlueprintResult> {
  assertRouteSet(request.routes);
  assertLandscapeUsable(request.competitive_landscape);

  const llm = deps.llm ?? getLlmService();
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const landscape = request.competitive_landscape.payload;

  const evidence = await gatherDonorEvidence(landscape, dataForSeo);

  // 1. Compact global route strategy — intent-level plan only, exact route-set
  //    parity (no missing, no extra, no duplicate route ID).
  const globalPlan = await planGlobalRouteStrategy(llm, request, landscape, evidence);

  // 2. Deterministic batches from request.routes order. Every batch receives
  //    global site awareness: all_routes MAY be referenced for internal links,
  //    current_batch_routes MUST be returned.
  const batches = chunkRoutes(request.routes);
  const allRouteIds = new Set(request.routes.map((route) => route.route_id));
  const batchResults = await Promise.all(
    batches.map((batch, index) =>
      generateBatchBlueprint(
        llm,
        request,
        landscape,
        evidence,
        globalPlan,
        batch,
        allRouteIds,
        index,
      ),
    ),
  );

  // 3. Deterministic whole-site merge in requested order — never completion
  //    order. Duplicate or missing generated routes throw.
  const routes = mergeBatchResults(batchResults, request.routes, allRouteIds);

  // 4. Existing whole-site semantic checks run again on the merged site.
  assertBlueprintSemantics(routes, allRouteIds);

  const landscapeRef = refForArtifact(request.competitive_landscape);
  const payload: SEOContentBlueprintV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
    competitive_landscape_ref: landscapeRef,
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
      batches: batches.length,
      competitiveLandscapeRef: payload.competitive_landscape_ref.artifact_id,
      artifactId: artifact.artifact_id,
    },
    "SEOContentBlueprint sealed",
  );

  return {
    artifact,
    evidence: {
      route_count: request.routes.length,
      batch_size: SEO_BLUEPRINT_BATCH_SIZE,
      batch_count: batches.length,
      completed_batches: batchResults.length,
      missing_route_ids: [],
      extra_route_ids: [],
    },
  };
}

/**
 * Compact global plan call. It must NOT produce full route blueprints — only
 * the intent-level summary the batch prompts consume as global strategy.
 */
async function planGlobalRouteStrategy(
  llm: LlmService,
  request: SEOContentBlueprintRequest,
  landscape: CompetitiveLandscapeArtifact["payload"],
  evidence: NormalizedDonorEvidence[],
): Promise<GlobalRouteIntentRoute[] | null> {
  if (request.routes.length <= SEO_BLUEPRINT_BATCH_SIZE) {
    return null;
  }
  const systemPrompt =
    "You are a senior SEO content strategist. Produce a COMPACT site-level route " +
    "strategy: for every route, decide only its primary query, primary search " +
    "intent, and journey stage. You do NOT decide topics, entities, requirements, " +
    "internal links, metadata, or prose — the per-batch planner does that. " +
    'Respond with ONLY a JSON object {"routes":[...]} — no markdown fences, no commentary.';

  const userPrompt = JSON.stringify(
    {
      market: landscape.market,
      query_portfolio: landscape.query_portfolio,
      selected_donors: landscape.selected_donors,
      normalized_donor_evidence: evidence,
      routes: request.routes.map(({ route_id, path, purpose }) => ({
        route_id,
        path,
        purpose,
      })),
      verified_business_facts: request.business_facts,
      output_contract: {
        one_entry_per_route_id: request.routes.map((route) => route.route_id),
        route_shape: {
          route_id: "string",
          primary_query: "string",
          primary_intent: "string",
          journey_stage: "one of: informational | commercial | transactional",
        },
        note: "Compact intent-level plan only. Do NOT add topics, entities, requirements, internal links, metadata, or any other field.",
      },
    },
    null,
    2,
  );

  return llm.strategizeJson<GlobalRouteIntentRoute[]>({
    clientId: request.client_id,
    module: "build-intelligence",
    purpose: `seo-content-blueprint:${request.build_id}:global-route-strategy`,
    systemPrompt,
    userPrompt,
    validate: (value) => reconcileGlobalRouteStrategy(value, request.routes),
  });
}

/**
 * The global plan must cover exactly the requested route set — no missing, no
 * extra, no duplicate route ID — and is returned in requested order.
 */
function reconcileGlobalRouteStrategy(
  value: unknown,
  requested: SEOContentBlueprintRequest["routes"],
): GlobalRouteIntentRoute[] {
  const parsed = globalRouteIntentSchema.parse(value);
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));
  if (byId.size !== parsed.routes.length) {
    throw new SeoContentBlueprintInvalidError("Duplicate route_id in global plan output");
  }
  const requestedIds = new Set(requested.map((route) => route.route_id));
  const unexpected = parsed.routes
    .map((route) => route.route_id)
    .filter((id) => !requestedIds.has(id));
  if (unexpected.length > 0) {
    throw new SeoContentBlueprintInvalidError(
      `Unexpected route_id(s) in global plan: ${unexpected.join(", ")}`,
    );
  }
  return requested.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new SeoContentBlueprintInvalidError(
        `Missing global plan for required route_id: ${route.route_id}`,
      );
    }
    return produced;
  });
}

/** One batch's full blueprint generation with global site awareness. */
async function generateBatchBlueprint(
  llm: LlmService,
  request: SEOContentBlueprintRequest,
  landscape: CompetitiveLandscapeArtifact["payload"],
  evidence: NormalizedDonorEvidence[],
  globalPlan: GlobalRouteIntentRoute[] | null,
  batchRoutes: SEOContentBlueprintRequest["routes"],
  allRouteIds: Set<string>,
  batchIndex: number,
): Promise<SEOContentBlueprintRoute[]> {
  const systemPrompt =
    "You are a senior SEO content strategist. You produce a STRATEGIC content " +
    "blueprint from normalized competitive evidence and verified business facts. " +
    "You decide search intent, supporting queries, topics, entities, questions, " +
    "competitive content gaps, content requirements, internal-link requirements, " +
    "AEO/GEO requirements, metadata requirements, forbidden claims, and acceptance " +
    "tests. You do NOT decide page layout, section order, component classes, visual " +
    "design, CTA placement, or final prose. Respond with ONLY a JSON object " +
    '{"routes":[...]} — no markdown fences, no commentary.';

  const userPrompt = JSON.stringify(
    {
      market: landscape.market,
      query_portfolio: landscape.query_portfolio,
      selected_donors: landscape.selected_donors,
      normalized_donor_evidence: evidence,
      all_routes: request.routes.map(({ route_id, path, purpose }) => ({
        route_id,
        path,
        purpose,
      })),
      global_route_strategy: globalPlan ?? [],
      current_batch_routes: batchRoutes,
      verified_business_facts: request.business_facts,
      seo_config: request.seo_config ?? {},
      output_contract: {
        one_entry_per_route_id: batchRoutes.map((route) => route.route_id),
        route_shape: {
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
          requirements: {
            requirement_id: "string",
            target_slots: "content slot names (string[])",
            placement: "one of: FIRST_MATCH | ALL_MATCHES",
            required_topics: "string[]",
            required_entities: "string[]",
            questions: "string[]",
            proof_needed: "string[]",
            required: "boolean",
          },
          competitive_gaps: [
            {
              gap_id: "string",
              description: "string",
              donor_domains: "string[]",
              opportunity: "string",
            },
          ],
          internal_links: [
            { target_route_id: "string (must be one of the route_ids above)", purpose: "string" },
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
        note: "Return exactly one route object per route_id in current_batch_routes, matching route_shape exactly. Internal links may target any route_id in all_routes. Do not add layout, component, or prose fields.",
      },
    },
    null,
    2,
  );

  return llm.strategizeJson<SEOContentBlueprintRoute[]>({
    clientId: request.client_id,
    module: "build-intelligence",
    purpose: `seo-content-blueprint:${request.build_id}:batch-${batchIndex + 1}`,
    systemPrompt,
    userPrompt,
    validate: (value) => reconcileBatchRoutes(value, batchRoutes, allRouteIds),
  });
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
 * Validate one batch's model output against the shared route schema and
 * reconcile it with the REQUESTED batch identities. Route identity (route_id +
 * path) is an input, not the model's to invent or change — identities are
 * re-asserted from the request and routes are returned in batch order
 * (deterministic). Routes from OTHER batches are rejected here. Missing or
 * unexpected routes throw, triggering the single bounded repair.
 */
function reconcileBatchRoutes(
  value: unknown,
  batchRoutes: Array<{ route_id: string; path: string; purpose: string }>,
  allRouteIds: Set<string>,
): SEOContentBlueprintRoute[] {
  // Slot vocabulary is enforced here: `target_slots` is a zod enum over the
  // shared ContentSlot union, so an invented slot name fails the parse.
  const parsed = seoContentBlueprintRoutesSchema.parse(value);
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));

  if (byId.size !== parsed.routes.length) {
    throw new SeoContentBlueprintInvalidError("Duplicate route_id in model output");
  }

  const batchIds = new Set(batchRoutes.map((route) => route.route_id));
  // No route from another batch may appear in this batch's output.
  const unexpected = parsed.routes
    .map((route) => route.route_id)
    .filter((id) => !batchIds.has(id));
  if (unexpected.length > 0) {
    throw new SeoContentBlueprintInvalidError(
      `Unexpected route_id(s) not in the requested set: ${unexpected.join(", ")}`,
    );
  }

  const routes = batchRoutes.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new SeoContentBlueprintInvalidError(
        `Missing blueprint for required route_id: ${route.route_id}`,
      );
    }
    // Re-assert identity from the request (authority), keep strategic fields.
    return { ...produced, route_id: route.route_id, path: route.path };
  });

  // Internal links validate against the WHOLE site (allRouteIds), not just
  // this batch: a route in batch 3 may correctly link to a route in batch 8.
  assertBlueprintSemantics(routes, allRouteIds);
  return routes;
}

/**
 * Deterministic whole-site merge: never concatenate in completion order.
 * Batch outputs are merged by route_id, duplicates throw, and the final order
 * is exactly request.routes order. Missing routes throw.
 */
function mergeBatchResults(
  batchResults: SEOContentBlueprintRoute[][],
  requested: SEOContentBlueprintRequest["routes"],
  allRouteIds: Set<string>,
): SEOContentBlueprintRoute[] {
  const produced = new Map<string, SEOContentBlueprintRoute>();
  for (const batch of batchResults) {
    for (const route of batch) {
      if (produced.has(route.route_id)) {
        throw new SeoContentBlueprintInvalidError(
          `Duplicate generated route: ${route.route_id}`,
        );
      }
      produced.set(route.route_id, route);
    }
  }
  const missing = requested.filter((route) => !produced.has(route.route_id));
  if (missing.length > 0) {
    throw new SeoContentBlueprintInvalidError(
      `Missing generated route: ${missing.map((route) => route.route_id).join(", ")}`,
    );
  }
  const extra = [...produced.keys()].filter((id) => !allRouteIds.has(id));
  if (extra.length > 0) {
    throw new SeoContentBlueprintInvalidError(`Extra generated route: ${extra.join(", ")}`);
  }
  return requested.map((route) => produced.get(route.route_id)!);
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
