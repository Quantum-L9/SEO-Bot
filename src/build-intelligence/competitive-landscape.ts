/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CompetitiveLandscape (deterministic ranking truth, ZERO LLM)
 *
 * DataForSEO organic SERP → normalized observations → per-domain visibility →
 * exactly 10 qualified operating-company donors. No LLM invocation anywhere in
 * this path: rank, visibility, and donor selection are pure functions of SERP
 * evidence. Incomplete cohorts are never sealed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { DataForSeoClient, type OrganicSerpResult } from "../services/dataforseo.js";
import { canonicalizeDomain, qualifyDomain } from "./domain-classification.js";
import { CompetitiveEvidenceIncompleteError } from "./errors.js";
import { PRODUCER } from "./producer.js";
import {
  HARD_EXPANSION_CEILING,
  initialPortfolio,
  MAX_EXPANSION_ROUNDS,
  type PortfolioQuery,
  planExpansionRound,
} from "./query-expansion.js";

export { CompetitiveEvidenceIncompleteError } from "./errors.js";

const logger = createModuleLogger("build-intelligence:competitive-landscape");

/** Hard artifact invariant — never lowered. */
export const REQUIRED_DONOR_COUNT = 10;

/** Minimal DataForSEO surface this producer depends on (injectable for tests). */
export interface DataForSeoOrganicPort {
  getOrganicSerp(params: {
    keyword: string;
    locationName?: string;
    languageName?: string;
    device?: "desktop" | "mobile";
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
    device?: "desktop" | "mobile";
    location_name?: string;
  };
  seed_queries: Array<{
    query: string;
    intent: "informational" | "commercial" | "transactional" | "local";
    weight?: number;
  }>;
  /** Ignored when below REQUIRED_DONOR_COUNT. Never lowers the hard invariant. */
  desired_donor_count?: number;
  /** Operator-supplied domains to exclude (recorded with reason). */
  operator_exclusions?: string[];
}

/** visibility contribution of a single observation: weight × 1/log2(rank+1). */
export function visibilityContribution(weight: number, rank: number): number {
  return weight * (1 / Math.log2(rank + 1));
}

interface DomainAggregate {
  domain: string;
  visibility: number;
  queryIds: Set<string>;
  observationIds: string[];
  firstSeenOrder: number;
}

export interface QueryCollectionState {
  queryPortfolio: CompetitiveLandscapeV1["query_portfolio"];
  observations: CompetitiveLandscapeV1["observations"];
  aggregates: Map<string, DomainAggregate>;
  seenOrder: number;
  expansion: Array<{
    query_id: string;
    query: string;
    reason: string;
    round: number;
  }>;
  originalQueryCount: number;
}

/**
 * Build a CompetitiveLandscape artifact from live/fixture SERP evidence.
 * Seals only when exactly 10 qualified operating-company donors exist.
 */
export async function createCompetitiveLandscape(
  request: CompetitiveLandscapeRequest,
  deps: { dataForSeo?: DataForSeoOrganicPort } = {},
): Promise<CompetitiveLandscapeArtifact> {
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const device = request.market.device ?? "desktop";
  const locationName = request.market.location_name ?? request.market.country;

  const original = initialPortfolio(request.seed_queries);
  const state: QueryCollectionState = {
    queryPortfolio: [],
    observations: [],
    aggregates: new Map<string, DomainAggregate>(),
    seenOrder: 0,
    expansion: [],
    originalQueryCount: original.length,
  };

  await collectQueryObservations(original, request, dataForSeo, locationName, device, state);

  const operatorExclusions = new Set(
    (request.operator_exclusions ?? []).map(canonicalizeDomain).filter(Boolean),
  );

  let qualifiedCount = countQualifiedDonors(state, operatorExclusions);
  let round = 0;
  while (qualifiedCount < REQUIRED_DONOR_COUNT && round < MAX_EXPANSION_ROUNDS) {
    round += 1;
    const planned = planExpansionRound({
      round,
      niche: request.market.niche,
      market: request.market,
      existingQueries: state.queryPortfolio.map((q) => q.query),
      originalQueries: original.map((q) => q.query),
      addedSoFar: state.expansion.length,
    });
    if (planned.length === 0) break;
    const added: PortfolioQuery[] = planned.map(({ query_id, query, intent, weight }) => ({
      query_id,
      query,
      intent,
      weight,
    }));
    for (const item of planned) {
      state.expansion.push({
        query_id: item.query_id,
        query: item.query,
        reason: item.reason,
        round: item.round,
      });
    }
    await collectQueryObservations(added, request, dataForSeo, locationName, device, state);
    qualifiedCount = countQualifiedDonors(state, operatorExclusions);
  }

  const orderedAggregates = [...state.aggregates.values()].sort(compareAggregates);
  const { exclusions, excludedDomains } = applyExclusions(
    orderedAggregates,
    operatorExclusions,
    state.aggregates,
  );

  const domains: CompetitiveLandscapeV1["domains"] = orderedAggregates.map((aggregate) => ({
    domain: aggregate.domain,
    aggregate_visibility: round6(aggregate.visibility),
    qualifying_query_ids: [...aggregate.queryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    observation_ids: aggregate.observationIds,
  }));

  const donorCandidates = orderedAggregates.filter(
    (aggregate) => !excludedDomains.has(aggregate.domain),
  );
  const selectedDonors: CompetitiveLandscapeV1["selected_donors"] = donorCandidates
    .slice(0, REQUIRED_DONOR_COUNT)
    .map((aggregate) => ({
      domain: aggregate.domain,
      aggregate_visibility: round6(aggregate.visibility),
      observation_ids: aggregate.observationIds,
    }));

  if (selectedDonors.length !== REQUIRED_DONOR_COUNT) {
    throw new CompetitiveEvidenceIncompleteError(
      `COMPETITIVE_EVIDENCE_INCOMPLETE: ${selectedDonors.length} qualified operating-company donors ` +
        `(required ${REQUIRED_DONOR_COUNT}) from ${state.observations.length} observation(s) across ` +
        `${state.queryPortfolio.length} queries (${state.originalQueryCount} original, ` +
        `${state.expansion.length} expanded, ceiling ${HARD_EXPANSION_CEILING}).`,
    );
  }

  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: {
      niche: request.market.niche,
      country: request.market.country,
      language: request.market.language,
      device,
      ...(request.market.location_name ? { location_name: request.market.location_name } : {}),
    },
    query_portfolio: state.queryPortfolio,
    observations: state.observations,
    domains,
    selected_donors: selectedDonors,
    exclusions,
    evidence_complete: true,
  };

  const artifact = sealIntelligenceArtifact({
    artifact_type: "competitive_landscape",
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
      observations: state.observations.length,
      originalQueries: state.originalQueryCount,
      expandedQueries: state.expansion.length,
      exclusions: exclusions.length,
      evidenceComplete: true,
      rankingLlmCalls: 0,
      artifactId: artifact.artifact_id,
    },
    "CompetitiveLandscape sealed",
  );

  return artifact;
}

async function collectQueryObservations(
  queries: PortfolioQuery[],
  request: CompetitiveLandscapeRequest,
  dataForSeo: DataForSeoOrganicPort,
  locationName: string,
  device: "desktop" | "mobile",
  state: QueryCollectionState,
): Promise<void> {
  for (const seed of queries) {
    state.queryPortfolio.push({
      query_id: seed.query_id,
      query: seed.query,
      intent: seed.intent,
      weight: seed.weight,
    });

    // Provider/task/malformed failures propagate. A valid empty SERP is kept.
    const serp = await dataForSeo.getOrganicSerp({
      keyword: seed.query,
      locationName,
      languageName: request.market.language,
      device,
    });

    const seenDomainForQuery = new Set<string>();
    for (const item of serp.items) {
      const rank = item.rankGroup;
      if (typeof rank !== "number" || rank < 1) continue;
      const canonical = canonicalizeDomain(item.domain || item.url);
      if (!canonical) continue;
      if (seenDomainForQuery.has(canonical)) continue;
      seenDomainForQuery.add(canonical);

      const observationId = `${seed.query_id}-r${rank}-${canonical}`;
      state.observations.push({
        observation_id: observationId,
        query_id: seed.query_id,
        rank,
        url: item.url,
        domain: canonical,
        observed_at: serp.observedAt,
        source: "dataforseo",
      });

      let aggregate = state.aggregates.get(canonical);
      if (!aggregate) {
        aggregate = {
          domain: canonical,
          visibility: 0,
          queryIds: new Set(),
          observationIds: [],
          firstSeenOrder: state.seenOrder++,
        };
        state.aggregates.set(canonical, aggregate);
      }
      aggregate.visibility += visibilityContribution(seed.weight, rank);
      aggregate.queryIds.add(seed.query_id);
      aggregate.observationIds.push(observationId);
    }
  }
}

function countQualifiedDonors(
  state: QueryCollectionState,
  operatorExclusions: Set<string>,
): number {
  let count = 0;
  for (const aggregate of state.aggregates.values()) {
    if (operatorExclusions.has(aggregate.domain)) continue;
    if (qualifyDomain(aggregate.domain).status !== "qualified") continue;
    if (aggregate.observationIds.length < 1) continue;
    count += 1;
  }
  return count;
}

function applyExclusions(
  orderedAggregates: DomainAggregate[],
  operatorExclusions: Set<string>,
  aggregates: Map<string, DomainAggregate>,
): { exclusions: CompetitiveLandscapeV1["exclusions"]; excludedDomains: Set<string> } {
  const exclusions: CompetitiveLandscapeV1["exclusions"] = [];
  const excludedDomains = new Set<string>();

  for (const aggregate of orderedAggregates) {
    if (operatorExclusions.has(aggregate.domain)) {
      exclusions.push({ domain: aggregate.domain, reason: "operator_exclusion" });
      excludedDomains.add(aggregate.domain);
      continue;
    }
    const qualification = qualifyDomain(aggregate.domain);
    if (qualification.status === "excluded" && qualification.reason) {
      exclusions.push({ domain: aggregate.domain, reason: qualification.reason });
      excludedDomains.add(aggregate.domain);
      continue;
    }
    if (qualification.status === "unknown") {
      exclusions.push({ domain: aggregate.domain, reason: "irrelevant" });
      excludedDomains.add(aggregate.domain);
    }
  }

  for (const domain of operatorExclusions) {
    if (!aggregates.has(domain)) {
      exclusions.push({ domain, reason: "operator_exclusion" });
      excludedDomains.add(domain);
    }
  }

  return { exclusions, excludedDomains };
}

function compareAggregates(a: DomainAggregate, b: DomainAggregate): number {
  if (b.visibility !== a.visibility) return b.visibility - a.visibility;
  if (a.firstSeenOrder !== b.firstSeenOrder) return a.firstSeenOrder - b.firstSeenOrder;
  return a.domain.localeCompare(b.domain);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
