/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 2 — CompetitiveLandscape (deterministic ranking truth, ZERO LLM)
 *
 * DataForSEO organic SERP → normalized observations → per-domain visibility →
 * donor cohort. No LLM invocation anywhere in this path: rank, visibility, and
 * donor selection are pure, deterministic functions of the SERP evidence.
 *
 * Sealed via @quantum-l9/bot-interop (`sealIntelligenceArtifact`). The shared
 * `CompetitiveLandscapeV1` payload is the contract — never redefined here.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  sealIntelligenceArtifact,
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from '@quantum-l9/bot-interop';
import { createModuleLogger } from '../core/logger.js';
import { DataForSeoClient, type OrganicSerpResult } from '../services/dataforseo.js';
import { PRODUCER } from './producer.js';
import { canonicalizeDomain, classifyDomain } from './domain-classification.js';

const logger = createModuleLogger('build-intelligence:competitive-landscape');

/** Minimal DataForSEO surface this producer depends on (injectable for tests). */
export interface DataForSeoOrganicPort {
  getOrganicSerp(params: {
    keyword: string;
    locationName?: string;
    languageName?: string;
    device?: 'desktop' | 'mobile';
    depth?: number;
  }): Promise<OrganicSerpResult>;
}

export interface CompetitiveLandscapeRequest {
  client_id: string;
  build_id: string;
  market: {
    niche: string;
    country: string;
    language: string;
    device?: 'desktop' | 'mobile';
    location_name?: string;
  };
  seed_queries: Array<{
    query: string;
    intent: 'informational' | 'commercial' | 'transactional' | 'local';
    weight?: number;
  }>;
  /** Target donor cohort size. Default 10. */
  desired_donor_count?: number;
  /** Operator-supplied domains to exclude (recorded with reason). */
  operator_exclusions?: string[];
}

/** Thrown when there is not a single real SERP observation to build donors from. */
export class CompetitiveEvidenceIncompleteError extends Error {
  readonly code = 'COMPETITIVE_EVIDENCE_INCOMPLETE';
  constructor(message: string) {
    super(message);
    this.name = 'CompetitiveEvidenceIncompleteError';
  }
}

const DEFAULT_DONOR_COUNT = 10;

/** visibility contribution of a single observation: weight × 1/log2(rank+1). */
function visibilityContribution(weight: number, rank: number): number {
  // rank is the organic position (>=1); log2(rank+1) is defined and > 0.
  return weight * (1 / Math.log2(rank + 1));
}

/** Stable per-query identifier derived from position in the request. */
function queryId(index: number): string {
  return `q${index + 1}`;
}

interface DomainAggregate {
  domain: string;
  visibility: number;
  queryIds: Set<string>;
  observationIds: string[];
  firstSeenOrder: number;
}

/**
 * Build a CompetitiveLandscape artifact from live/fixture SERP evidence.
 * Deterministic: identical SERP responses (including their `observedAt`) yield
 * an identical sealed payload digest.
 */
export async function createCompetitiveLandscape(
  request: CompetitiveLandscapeRequest,
  deps: { dataForSeo?: DataForSeoOrganicPort } = {},
): Promise<CompetitiveLandscapeArtifact> {
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const desiredDonorCount = request.desired_donor_count ?? DEFAULT_DONOR_COUNT;
  const device = request.market.device ?? 'desktop';
  const locationName = request.market.location_name ?? request.market.country;

  const queryPortfolio: CompetitiveLandscapeV1['query_portfolio'] = [];
  const observations: CompetitiveLandscapeV1['observations'] = [];
  const aggregates = new Map<string, DomainAggregate>();
  let seenOrder = 0;

  for (let i = 0; i < request.seed_queries.length; i++) {
    const seed = request.seed_queries[i]!;
    const qid = queryId(i);
    const weight = typeof seed.weight === 'number' && seed.weight > 0 ? seed.weight : 1;
    queryPortfolio.push({ query_id: qid, query: seed.query, intent: seed.intent, weight });

    let serp: OrganicSerpResult;
    try {
      serp = await dataForSeo.getOrganicSerp({
        keyword: seed.query,
        locationName,
        languageName: request.market.language,
        device,
      });
    } catch (error) {
      logger.warn(
        { query: seed.query, error: error instanceof Error ? error.message : String(error) },
        'SERP fetch failed for seed query; query yields zero observations',
      );
      continue;
    }

    for (const item of serp.items) {
      const rank = item.rankGroup; // organic position only
      if (typeof rank !== 'number' || rank < 1) continue;
      const canonical = canonicalizeDomain(item.domain || item.url);
      if (!canonical) continue;
      const observationId = `${qid}-r${rank}`;
      observations.push({
        observation_id: observationId,
        query_id: qid,
        rank,
        url: item.url,
        domain: canonical,
        observed_at: serp.observedAt,
        source: 'dataforseo',
      });

      let aggregate = aggregates.get(canonical);
      if (!aggregate) {
        aggregate = { domain: canonical, visibility: 0, queryIds: new Set(), observationIds: [], firstSeenOrder: seenOrder++ };
        aggregates.set(canonical, aggregate);
      }
      aggregate.visibility += visibilityContribution(weight, rank);
      aggregate.queryIds.add(qid);
      aggregate.observationIds.push(observationId);
    }
  }

  // ── Exclusions: operator input first, then structural classification ──────────
  const operatorExclusions = new Set(
    (request.operator_exclusions ?? []).map(canonicalizeDomain).filter(Boolean),
  );
  const exclusions: CompetitiveLandscapeV1['exclusions'] = [];
  const excludedDomains = new Set<string>();

  // Deterministic domain ordering for all downstream lists: visibility desc,
  // then first-seen order asc, then domain asc.
  const orderedAggregates = [...aggregates.values()].sort(compareAggregates);

  for (const aggregate of orderedAggregates) {
    if (operatorExclusions.has(aggregate.domain)) {
      exclusions.push({ domain: aggregate.domain, reason: 'operator_exclusion' });
      excludedDomains.add(aggregate.domain);
      continue;
    }
    const reason = classifyDomain(aggregate.domain);
    if (reason) {
      exclusions.push({ domain: aggregate.domain, reason });
      excludedDomains.add(aggregate.domain);
    }
  }

  // Operator exclusions that never appeared in the SERP are still recorded, so
  // the artifact is an honest ledger of what the operator asked to remove.
  for (const domain of operatorExclusions) {
    if (!aggregates.has(domain)) {
      exclusions.push({ domain, reason: 'operator_exclusion' });
      excludedDomains.add(domain);
    }
  }

  const domains: CompetitiveLandscapeV1['domains'] = orderedAggregates.map((aggregate) => ({
    domain: aggregate.domain,
    aggregate_visibility: round(aggregate.visibility),
    qualifying_query_ids: [...aggregate.queryIds].sort(),
    observation_ids: aggregate.observationIds,
  }));

  const donorCandidates = orderedAggregates.filter((aggregate) => !excludedDomains.has(aggregate.domain));
  const selectedDonors: CompetitiveLandscapeV1['selected_donors'] = donorCandidates
    .slice(0, desiredDonorCount)
    .map((aggregate) => ({
      domain: aggregate.domain,
      aggregate_visibility: round(aggregate.visibility),
      observation_ids: aggregate.observationIds,
    }));

  // ── Evidence gate ────────────────────────────────────────────────────────────
  // Every selected donor already resolves to >=1 observation (candidacy requires
  // an aggregate, which requires an observation). Zero donors === no usable
  // evidence: fail closed. A partial cohort is returned honestly with
  // evidence_complete=false.
  if (selectedDonors.length === 0) {
    throw new CompetitiveEvidenceIncompleteError(
      `No donor cohort could be formed from ${observations.length} observation(s) across ${request.seed_queries.length} seed queries.`,
    );
  }
  const evidenceComplete = selectedDonors.length >= desiredDonorCount;

  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: {
      niche: request.market.niche,
      country: request.market.country,
      language: request.market.language,
      device,
      ...(request.market.location_name ? { location_name: request.market.location_name } : {}),
    },
    query_portfolio: queryPortfolio,
    observations,
    domains,
    selected_donors: selectedDonors,
    exclusions,
    evidence_complete: evidenceComplete,
  };

  const artifact = sealIntelligenceArtifact({
    artifact_type: 'competitive_landscape',
    client_id: request.client_id,
    build_id: request.build_id,
    producer: PRODUCER,
    payload,
  });

  logger.info(
    {
      clientId: request.client_id,
      buildId: request.build_id,
      donors: selectedDonors.length,
      requested: desiredDonorCount,
      observations: observations.length,
      exclusions: exclusions.length,
      evidenceComplete,
      artifactId: artifact.artifact_id,
    },
    'CompetitiveLandscape sealed',
  );

  return artifact;
}

function compareAggregates(a: DomainAggregate, b: DomainAggregate): number {
  if (b.visibility !== a.visibility) return b.visibility - a.visibility;
  if (a.firstSeenOrder !== b.firstSeenOrder) return a.firstSeenOrder - b.firstSeenOrder;
  return a.domain.localeCompare(b.domain);
}

/** Round to 6 dp so floating-point noise never perturbs the canonical digest. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
