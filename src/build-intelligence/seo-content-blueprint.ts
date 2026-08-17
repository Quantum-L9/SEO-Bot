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
  type CompetitiveLandscapeArtifact,
  refForArtifact,
  type SEOContentBlueprintArtifact,
  type SEOContentBlueprintRoute,
  type SEOContentBlueprintV1,
  sealIntelligenceArtifact,
  type VerifiedBusinessFact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { DataForSeoClient } from "../services/dataforseo.js";
import { getLlmService, type LlmService } from "../services/llm.js";
import { REQUIRED_DONOR_COUNT } from "./competitive-landscape.js";
import {
  ArtifactLineageMismatchError,
  CompetitiveLandscapeInvalidError,
  CompetitiveLandscapeRefMismatchError,
  ContentSlotInvalidError,
  RouteSetMismatchError,
  SeoContentBlueprintInvalidError,
} from "./errors.js";
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

export async function createSEOContentBlueprint(
  request: SEOContentBlueprintRequest,
  deps: { llm?: LlmService; dataForSeo?: PageContentPort } = {},
): Promise<SEOContentBlueprintArtifact> {
  if (request.routes.length === 0) {
    throw new SeoContentBlueprintInvalidError(
      "SEO_CONTENT_BLUEPRINT_INVALID: at least one route identity is required",
    );
  }
  assertLandscapeLineage(request);
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
    "design, CTA placement, or final prose. Respond with ONLY a JSON object " +
    '{"routes":[...]} — no markdown fences, no commentary.';

  const userPrompt = JSON.stringify(
    {
      market: landscape.market,
      query_portfolio: landscape.query_portfolio,
      selected_donors: landscape.selected_donors,
      normalized_donor_evidence: evidence,
      routes: request.routes,
      verified_business_facts: request.business_facts,
      seo_config: request.seo_config ?? {},
      output_contract: {
        one_entry_per_route_id: request.routes.map((route) => route.route_id),
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
        note: "Return exactly one route object per route_id above, matching route_shape exactly. Do not add layout, component, or prose fields.",
      },
    },
    null,
    2,
  );

  const routes = await llm.strategizeJson<SEOContentBlueprintRoute[]>({
    clientId: request.client_id,
    module: "build-intelligence",
    purpose: `seo-content-blueprint:${request.build_id}`,
    systemPrompt,
    userPrompt,
    validate: (value) =>
      reconcileRoutes(value, request.routes, request.seo_config?.forbidden_claims ?? []),
  });

  const landscapeRef = refForArtifact(request.competitive_landscape);
  const payload: SEOContentBlueprintV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
    competitive_landscape_ref: landscapeRef,
    routes,
  };
  if (payload.competitive_landscape_ref.artifact_id !== landscapeRef.artifact_id) {
    throw new CompetitiveLandscapeRefMismatchError(
      "SEOContentBlueprint competitive_landscape_ref does not match the request artifact",
    );
  }

  const artifact = sealIntelligenceArtifact({
    artifact_type: "seo_content_blueprint",
    client_id: request.client_id,
    build_id: request.build_id,
    producer: PRODUCER,
    input_refs: [refForArtifact(request.competitive_landscape)],
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
 * Validate model output against the shared route schema and reconcile it with
 * the REQUESTED route identities. Route identity (route_id + path) is an input,
 * not the model's to invent or change — so identities are re-asserted from the
 * request and routes are returned in the requested order (deterministic).
 * Missing or unexpected routes throw, triggering the single bounded repair.
 */
function assertLandscapeLineage(request: SEOContentBlueprintRequest): void {
  const landscape = request.competitive_landscape;
  if (landscape.artifact_type !== "competitive_landscape") {
    throw new CompetitiveLandscapeInvalidError(
      "COMPETITIVE_LANDSCAPE_INVALID: expected a competitive_landscape artifact",
    );
  }
  if (landscape.client_id !== request.client_id || landscape.build_id !== request.build_id) {
    throw new ArtifactLineageMismatchError(
      `ARTIFACT_LINEAGE_MISMATCH: landscape client/build ` +
        `(${landscape.client_id}/${landscape.build_id}) does not match request ` +
        `(${request.client_id}/${request.build_id})`,
    );
  }
  if (
    !landscape.payload.evidence_complete ||
    landscape.payload.selected_donors.length !== REQUIRED_DONOR_COUNT
  ) {
    throw new CompetitiveLandscapeInvalidError(
      `COMPETITIVE_LANDSCAPE_INVALID: landscape is not a complete ${REQUIRED_DONOR_COUNT}-donor artifact`,
    );
  }
}

function reconcileRoutes(
  value: unknown,
  requested: Array<{ route_id: string; path: string; purpose: string }>,
  requestForbiddenClaims: string[],
): SEOContentBlueprintRoute[] {
  let parsed: { routes: SEOContentBlueprintRoute[] };
  try {
    parsed = seoContentBlueprintRoutesSchema.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/target_slots|Invalid enum value/.test(message)) {
      throw new ContentSlotInvalidError(`CONTENT_SLOT_INVALID: ${message}`);
    }
    throw new SeoContentBlueprintInvalidError(`SEO_CONTENT_BLUEPRINT_INVALID: ${message}`);
  }
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));

  const requestedIds = new Set(requested.map((route) => route.route_id));
  const unexpected = parsed.routes
    .map((route) => route.route_id)
    .filter((id) => !requestedIds.has(id));
  if (unexpected.length > 0) {
    throw new RouteSetMismatchError(
      `ROUTE_SET_MISMATCH: unexpected route_id(s) not in the requested set: ${unexpected.join(", ")}`,
    );
  }

  const reconciled = requested.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new RouteSetMismatchError(
        `ROUTE_SET_MISMATCH: missing blueprint for required route_id: ${route.route_id}`,
      );
    }
    const forbidden = uniqueSorted([...produced.forbidden_claims, ...requestForbiddenClaims]);
    return { ...produced, route_id: route.route_id, path: route.path, forbidden_claims: forbidden };
  });

  for (const route of reconciled) {
    for (const link of route.internal_links) {
      if (!requestedIds.has(link.target_route_id)) {
        throw new RouteSetMismatchError(
          `ROUTE_SET_MISMATCH: internal link target "${link.target_route_id}" is not in the route set`,
        );
      }
    }
  }
  return reconciled;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
