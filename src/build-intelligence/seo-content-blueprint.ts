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
import { z } from "zod";
import { createModuleLogger } from "../core/logger.js";
import { DataForSeoClient } from "../services/dataforseo.js";
import { getLlmService, type LlmService } from "../services/llm.js";
import type { LlmRunRecorder } from "../services/llm-run-recorder.js";
import { PRODUCER } from "./producer.js";
import {
  type GlobalRouteIntentRoute,
  globalRouteIntentRouteSchema,
  seoContentBlueprintRoutesSchema,
} from "./schema-guards.js";

const logger = createModuleLogger("build-intelligence:seo-content-blueprint");

/**
 * Deterministic batch size for full-site blueprint production. The LLM never
 * chooses batching — the producer splits the requested route set into batches
 * of exactly this size (the final batch may be smaller).
 */
export const SEO_BLUEPRINT_BATCH_SIZE = 4;

// The compact per-route strategy summary produced in phase A for ALL routes is
// `GlobalRouteIntentRoute`; its zod authority lives in `schema-guards.js` with
// every other runtime guard for model output.

/**
 * A batch failed its single bounded repair. The whole artifact fails — a
 * partial route set (24/29) is never sealed as success.
 */
export class SeoContentBlueprintBatchInvalidError extends Error {
  readonly code = "SEO_CONTENT_BLUEPRINT_BATCH_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "SeoContentBlueprintBatchInvalidError";
  }
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function chunkRoutes<T>(routes: T[], size: number = SEO_BLUEPRINT_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < routes.length; index += size) {
    chunks.push(routes.slice(index, index + size));
  }
  return chunks;
}

/** Phase A validation: exact route count, exact IDs, no duplicate normalized queries. */
function parseGlobalRouteIntentPlan(
  value: unknown,
  requested: Array<{ route_id: string; path: string; purpose: string }>,
): GlobalRouteIntentRoute[] {
  const parsed = z.array(globalRouteIntentRouteSchema).parse(value);
  const requestedIds = new Set(requested.map((route) => route.route_id));
  if (parsed.length !== requested.length) {
    throw new Error(
      `Global intent plan produced ${parsed.length} entries for ${requested.length} routes`,
    );
  }
  const seenIds = new Set<string>();
  const seenQueries = new Set<string>();
  for (const intent of parsed) {
    if (!requestedIds.has(intent.route_id)) {
      throw new Error(`Global intent plan has unexpected route_id: ${intent.route_id}`);
    }
    if (seenIds.has(intent.route_id)) {
      throw new Error(`Global intent plan has duplicate route_id: ${intent.route_id}`);
    }
    seenIds.add(intent.route_id);
    const normalized = normalizeQuery(intent.primary_query);
    if (seenQueries.has(normalized)) {
      throw new Error(`Global intent plan has duplicate primary_query: "${intent.primary_query}"`);
    }
    seenQueries.add(normalized);
  }
  return parsed;
}

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

/**
 * Measured evidence about a batched blueprint run, for the integrity receipt.
 * A sealed artifact always carries a clean validation block, so the block
 * itself cannot tell you how the route set was split — this can.
 *
 * `batch_count` is the split the producer actually performed;
 * `completed_batches` is COUNTED as batches finish. They are equal on every
 * sealed artifact (a batch that fails its bounded repair fails the whole
 * artifact, so a partial run never seals) — the counter exists so that
 * invariant is observable rather than assumed.
 *
 * Deliberately NOT recorded here: LLM call counts. `strategizeJson` owns its
 * own bounded repair, so the producer cannot see how many calls a batch really
 * cost, and a counter incremented per batch here would silently understate it.
 * The run recorder (`deps.recorder`) captures them instead, at the LLM boundary
 * where each actual router call is visible — including a bounded repair.
 */
export interface SEOContentBlueprintEvidence {
  route_count: number;
  batch_size: number;
  batch_count: number;
  completed_batches: number;
}

export interface SEOContentBlueprintResult {
  artifact: SEOContentBlueprintArtifact;
  evidence: SEOContentBlueprintEvidence;
}

/**
 * Produce the sealed blueprint. Use `createSEOContentBlueprintWithEvidence`
 * when the caller also needs measured run evidence (the seam proof does).
 */
export async function createSEOContentBlueprint(
  request: SEOContentBlueprintRequest,
  deps: { llm?: LlmService; dataForSeo?: PageContentPort; recorder?: LlmRunRecorder } = {},
): Promise<SEOContentBlueprintArtifact> {
  return (await createSEOContentBlueprintWithEvidence(request, deps)).artifact;
}

export async function createSEOContentBlueprintWithEvidence(
  request: SEOContentBlueprintRequest,
  deps: { llm?: LlmService; dataForSeo?: PageContentPort; recorder?: LlmRunRecorder } = {},
): Promise<SEOContentBlueprintResult> {
  assertRouteSet(request.routes);
  assertLandscapeUsable(request.competitive_landscape);

  const llm = deps.llm ?? getLlmService();
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const landscape = request.competitive_landscape.payload;

  const evidence = await gatherDonorEvidence(landscape, dataForSeo);

  const systemPrompt =
    "You are a senior SEO content strategist. You produce a STRATEGIC content " +
    "blueprint from normalized competitive evidence and verified business facts. " +
    "You decide search intent, supporting queries, topics, entities, questions, " +
    "competitive content gaps, content requirements, internal-link requirements, " +
    "AEO/GEO requirements, metadata requirements, forbidden claims, and acceptance " +
    "tests. You do NOT decide page layout, section order, component classes, visual " +
    "design, CTA placement, or final prose. Respond with ONLY the requested JSON " +
    "shape — no markdown fences, no commentary.";

  const allRouteIds = new Set(request.routes.map((route) => route.route_id));
  const allRouteIndex = request.routes.map((route) => ({
    route_id: route.route_id,
    path: route.path,
    purpose: route.purpose,
  }));

  // ── PHASE A — global route intent plan (one compact call for ALL routes) ────
  const globalIntentPlan = await llm.strategizeJson<GlobalRouteIntentRoute[]>({
    clientId: request.client_id,
    module: "build-intelligence",
    purpose: `seo-content-blueprint:global-intent:${request.build_id}`,
    systemPrompt,
    userPrompt: JSON.stringify(
      {
        task: "global_route_intent_plan",
        market: landscape.market,
        routes: allRouteIndex,
        verified_business_facts: request.business_facts,
        seo_config: request.seo_config ?? {},
        output_contract: {
          shape: [
            {
              route_id: "string (exact route_id from routes above)",
              primary_query: "string (the single primary target query)",
              primary_intent: "string (top-level search intent)",
              journey_stage: "informational | commercial | transactional",
            },
          ],
          note: "Return exactly one entry per route_id above, in the requested order. No other fields. Every primary_query must be unique after normalization.",
        },
      },
      null,
      2,
    ),
    validate: (value) => parseGlobalRouteIntentPlan(value, request.routes),
    recorder: deps.recorder,
  });
  const intentById = new Map(globalIntentPlan.map((intent) => [intent.route_id, intent]));

  // ── PHASE B — deterministic route batches (the LLM never chooses batching) ──
  const batches = chunkRoutes(request.routes, SEO_BLUEPRINT_BATCH_SIZE);
  const producedById = new Map<string, SEOContentBlueprintRoute>();
  let completedBatches = 0;
  for (const [batchIndex, batch] of batches.entries()) {
    let batchRoutes: SEOContentBlueprintRoute[];
    try {
      batchRoutes = await llm.strategizeJson<SEOContentBlueprintRoute[]>({
        clientId: request.client_id,
        module: "build-intelligence",
        purpose: `seo-content-blueprint:batch-${batchIndex + 1}:${request.build_id}`,
        systemPrompt,
        userPrompt: JSON.stringify(
          {
            task: "seo_content_blueprint_batch",
            market: landscape.market,
            query_portfolio: landscape.query_portfolio,
            selected_donors: landscape.selected_donors,
            normalized_donor_evidence: evidence,
            all_route_index: allRouteIndex,
            global_route_intent_plan: globalIntentPlan,
            current_batch: batch,
            verified_business_facts: request.business_facts,
            seo_config: request.seo_config ?? {},
            output_contract: {
              one_entry_per_route_id: batch.map((route) => route.route_id),
              route_shape: {
                search_intent: {
                  primary: "reassert the primary_intent from the global intent plan",
                  secondary: "string[]",
                  journey_stage: "reassert the journey_stage from the global intent plan",
                },
                targets: {
                  primary_query: "reassert the primary_query from the global intent plan",
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
                  {
                    target_route_id:
                      "string (must be one of the all_route_index ids — other batches are valid targets)",
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
              note: "Return exactly one route object per route_id in the current_batch, matching route_shape exactly. The global strategy is already decided — do not silently change it in this batch.",
            },
          },
          null,
          2,
        ),
        validate: (value) => reconcileBatch(value, batch, allRouteIds, intentById),
        recorder: deps.recorder,
      });
    } catch (error) {
      // A batch that fails its one bounded repair fails the whole artifact.
      throw new SeoContentBlueprintBatchInvalidError(
        `Batch ${batchIndex + 1} failed validation after its bounded repair: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const route of batchRoutes) {
      producedById.set(route.route_id, route);
    }
    completedBatches += 1;
  }

  // ── Deterministic merge in requested order, then whole-site validation ──────
  const routes = request.routes.map((route) => {
    const produced = producedById.get(route.route_id);
    if (!produced) {
      throw new SeoContentBlueprintBatchInvalidError(
        `No produced route for requested route_id: ${route.route_id}`,
      );
    }
    return produced;
  });
  assertWholeSiteBlueprint(routes, request.routes, allRouteIds);

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
      completed_batches: completedBatches,
    },
  };
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
 * Validate ONE batch's model output against its own route identities, the
 * all-route ID set (internal-link authority), and the global intent plan
 * (strategy authority). The split authorities mean a batch can link to any
 * route on the site, but can never invent routes, and can never silently
 * change the global strategy.
 */
function reconcileBatch(
  value: unknown,
  batch: Array<{ route_id: string; path: string; purpose: string }>,
  allRouteIds: Set<string>,
  intentById: Map<string, GlobalRouteIntentRoute>,
): SEOContentBlueprintRoute[] {
  // Slot vocabulary is enforced here: `target_slots` is a zod enum over the
  // shared ContentSlot union, so an invented slot name fails the parse.
  const parsed = seoContentBlueprintRoutesSchema.parse(value);
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));

  if (byId.size !== parsed.routes.length) {
    throw new Error("Duplicate route_id in model output");
  }

  const batchIds = new Set(batch.map((route) => route.route_id));
  // Output route IDs must equal batch route IDs EXACTLY — no missing, no extras,
  // and no route belonging to another batch.
  const unexpected = parsed.routes.map((route) => route.route_id).filter((id) => !batchIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Batch contains route_id(s) outside this batch: ${unexpected.join(", ")}`);
  }

  const routes = batch.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new Error(`Missing blueprint for required route_id: ${route.route_id}`);
    }
    const intent = intentById.get(route.route_id);
    if (!intent) {
      throw new Error(`Missing global intent plan entry for route_id: ${route.route_id}`);
    }
    // Re-assert identity from the request (authority) and strategy from the
    // global intent plan (authority); keep the model's strategic detail fields.
    return {
      ...produced,
      route_id: route.route_id,
      path: route.path,
      search_intent: {
        ...produced.search_intent,
        primary: intent.primary_intent,
        journey_stage: intent.journey_stage,
      },
      targets: { ...produced.targets, primary_query: intent.primary_query },
    };
  });

  assertBatchSemantics(routes, allRouteIds);
  return routes;
}

/**
 * Deterministic semantic checks the zod shape cannot express, scoped to a
 * batch: internal links may target ANY route on the site (allRouteIds), and
 * requirement ids must be unique per route with valid target slots.
 */
function assertBatchSemantics(routes: SEOContentBlueprintRoute[], allRouteIds: Set<string>): void {
  for (const route of routes) {
    for (const link of route.internal_links) {
      if (!allRouteIds.has(link.target_route_id)) {
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

/**
 * Whole-site semantic validator run on the deterministic merge before sealing:
 * same route count, exact requested order and paths, no duplicate route IDs,
 * no unknown internal-link targets, no self-links, no duplicate requirement
 * IDs, all target slots valid, and no unintended duplicate primary queries.
 */
function assertWholeSiteBlueprint(
  routes: SEOContentBlueprintRoute[],
  requested: Array<{ route_id: string; path: string; purpose: string }>,
  allRouteIds: Set<string>,
): void {
  if (routes.length !== requested.length) {
    throw new SeoContentBlueprintBatchInvalidError(
      `Whole-site merge produced ${routes.length} routes for ${requested.length} requested`,
    );
  }
  const seenQueries = new Set<string>();
  for (let index = 0; index < requested.length; index++) {
    const route = routes[index];
    const wanted = requested[index];
    if (route.route_id !== wanted.route_id || route.path !== wanted.path) {
      throw new SeoContentBlueprintBatchInvalidError(
        `Whole-site merge order/path mismatch at index ${index}: expected ${wanted.route_id} (${wanted.path}), got ${route.route_id} (${route.path})`,
      );
    }
    const normalized = normalizeQuery(route.targets.primary_query);
    if (seenQueries.has(normalized)) {
      throw new SeoContentBlueprintBatchInvalidError(
        `Whole-site merge has duplicate primary_query: "${route.targets.primary_query}"`,
      );
    }
    seenQueries.add(normalized);
  }
  assertBatchSemantics(routes, allRouteIds);
}
