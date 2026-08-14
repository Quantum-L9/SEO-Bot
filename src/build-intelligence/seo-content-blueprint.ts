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
  refForArtifact,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
  type CompetitiveLandscapeArtifact,
  type SEOContentBlueprintArtifact,
  type SEOContentBlueprintRoute,
  type SEOContentBlueprintV1,
  type VerifiedBusinessFact,
} from '@quantum-l9/bot-interop';
import { createModuleLogger } from '../core/logger.js';
import { getLlmService, type LlmService } from '../services/llm.js';
import { DataForSeoClient } from '../services/dataforseo.js';
import { PRODUCER } from './producer.js';
import { seoContentBlueprintRoutesSchema } from './schema-guards.js';

const logger = createModuleLogger('build-intelligence:seo-content-blueprint');

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
    throw new Error('SEO_CONTENT_BLUEPRINT_NO_ROUTES: at least one route identity is required');
  }
  const llm = deps.llm ?? getLlmService();
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const landscape = request.competitive_landscape.payload;

  const evidence = await gatherDonorEvidence(landscape, dataForSeo);

  const systemPrompt =
    'You are a senior SEO content strategist. You produce a STRATEGIC content ' +
    'blueprint from normalized competitive evidence and verified business facts. ' +
    'You decide search intent, supporting queries, topics, entities, questions, ' +
    'competitive content gaps, content requirements, internal-link requirements, ' +
    'AEO/GEO requirements, metadata requirements, forbidden claims, and acceptance ' +
    'tests. You do NOT decide page layout, section order, component classes, visual ' +
    'design, CTA placement, or final prose. Respond with ONLY a JSON object ' +
    '{"routes":[...]} — no markdown fences, no commentary.';

  const userPrompt = JSON.stringify({
    market: landscape.market,
    query_portfolio: landscape.query_portfolio,
    selected_donors: landscape.selected_donors,
    normalized_donor_evidence: evidence,
    routes: request.routes,
    verified_business_facts: request.business_facts,
    seo_config: request.seo_config ?? {},
    output_contract: {
      one_entry_per_route_id: request.routes.map((route) => route.route_id),
      requirement_placement: ['FIRST_MATCH', 'ALL_MATCHES'],
      journey_stage: ['informational', 'commercial', 'transactional'],
      content_slots: [
        'primary_offer', 'service_overview', 'differentiation', 'trust', 'process',
        'project_proof', 'local_relevance', 'objection_handling', 'faq', 'conversion', 'metadata',
      ],
      note: 'Return exactly one route object per route_id above. Do not add layout, component, or prose fields.',
    },
  }, null, 2);

  const routes = await llm.strategizeJson<SEOContentBlueprintRoute[]>({
    clientId: request.client_id,
    module: 'build-intelligence',
    purpose: `seo-content-blueprint:${request.build_id}`,
    systemPrompt,
    userPrompt,
    validate: (value) => reconcileRoutes(value, request.routes),
  });

  const payload: SEOContentBlueprintV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint,
    competitive_landscape_ref: refForArtifact(request.competitive_landscape),
    routes,
  };

  const artifact = sealIntelligenceArtifact({
    artifact_type: 'seo_content_blueprint',
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
    'SEOContentBlueprint sealed',
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
  landscape: CompetitiveLandscapeArtifact['payload'],
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
          'Donor page-content pull failed; skipping this URL',
        );
      }
    }
  }
  return evidence;
}

/**
 * Validate model output against the shared route schema and reconcile it with
 * the REQUESTED route identities. Route identity (route_id + path) is an input,
 * not the model's to invent or change — so identities are re-asserted from the
 * request and routes are returned in the requested order (deterministic).
 * Missing or unexpected routes throw, triggering the single bounded repair.
 */
function reconcileRoutes(
  value: unknown,
  requested: Array<{ route_id: string; path: string; purpose: string }>,
): SEOContentBlueprintRoute[] {
  const parsed = seoContentBlueprintRoutesSchema.parse(value);
  const byId = new Map(parsed.routes.map((route) => [route.route_id, route]));

  const requestedIds = new Set(requested.map((route) => route.route_id));
  const unexpected = parsed.routes.map((route) => route.route_id).filter((id) => !requestedIds.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected route_id(s) not in the requested set: ${unexpected.join(', ')}`);
  }

  return requested.map((route) => {
    const produced = byId.get(route.route_id);
    if (!produced) {
      throw new Error(`Missing blueprint for required route_id: ${route.route_id}`);
    }
    // Re-assert identity from the request (authority), keep strategic fields.
    return { ...produced, route_id: route.route_id, path: route.path };
  });
}
