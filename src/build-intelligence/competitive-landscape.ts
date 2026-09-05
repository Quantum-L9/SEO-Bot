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
 * three-state donor qualification → donor cohort. No LLM invocation anywhere in
 * this path: rank, visibility, qualification, and donor selection are pure,
 * deterministic functions of the SERP evidence. This module imports no LLM
 * service, which is the structural proof that ranking authority is zero-LLM.
 *
 * FAIL CLOSED. Three separate gates stand between SERP evidence and a sealed
 * artifact:
 *   1. Every portfolio query must yield real evidence. A provider or task
 *      failure surfaces as a failure — it never degrades into zero observations.
 *   2. The donor cohort must reach the requested size (10) using only QUALIFIED
 *      operating-company domains. UNKNOWN and excluded domains never count.
 *   3. When the seed portfolio cannot reach the cohort, the portfolio is
 *      expanded deterministically in bounded rounds. Exhausting the bound is a
 *      failure, never a smaller cohort sealed as complete.
 *
 * Sealed via @quantum-l9/bot-interop (`sealIntelligenceArtifact`). The shared
 * `CompetitiveLandscapeV1` payload is the contract — never redefined or
 * extended here.
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
import {
  canonicalizeDomain,
  type DomainExclusionReason,
  type DonorQualification,
  qualifyDomain,
} from "./domain-classification.js";
import { byCodeUnit } from "./ordering.js";
import { PRODUCER } from "./producer.js";
import {
  buildSeedPortfolio,
  expandPortfolio,
  MAX_EXPANSION_ROUNDS,
  MAX_PORTFOLIO_QUERIES,
  type PortfolioQuery,
  type QueryPortfolio,
  type QueryProvenance,
  type SeedQueryInput,
} from "./query-portfolio.js";

const logger = createModuleLogger("build-intelligence:competitive-landscape");

/** Minimal DataForSEO surface this producer depends on (injectable for tests). */
export interface DataForSeoOrganicPort {
  getOrganicSerp(params: {
    keyword: string;
    locationName?: string;
    languageName?: string;
    device?: "desktop" | "mobile";
    depth?: number;
  }): Promise<OrganicSerpResult>;
  /** Total provider attempts across all calls — DataForSEO requests are billable. */
  providerAttempts?: number;
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
  seed_queries: SeedQueryInput[];
  /** Target donor cohort size. Default 10. This is a floor, not a hint. */
  desired_donor_count?: number;
  /** Operator-supplied domains to exclude (recorded with reason). */
  operator_exclusions?: string[];
}

/**
 * The SERP evidence cannot support the required donor cohort even after bounded
 * deterministic query expansion.
 */
export class CompetitiveEvidenceIncompleteError extends Error {
  readonly code = "COMPETITIVE_EVIDENCE_INCOMPLETE";
  constructor(
    message: string,
    readonly detail: {
      selected: number;
      required: number;
      qualified: number;
      unknown: number;
      excluded: number;
      queries: number;
      observations: number;
      expansion_rounds_used: number;
    },
  ) {
    super(message);
    this.name = "CompetitiveEvidenceIncompleteError";
  }
}

/**
 * There WAS a large enough raw candidate pool, but too few candidates qualify as
 * operating companies. Distinct from thin evidence: the market surfaced enough
 * domains, they just are not donors.
 */
export class CompetitiveDonorQualificationError extends Error {
  readonly code = "COMPETITIVE_DONOR_QUALIFICATION_FAILED";
  constructor(
    message: string,
    readonly detail: {
      selected: number;
      required: number;
      candidates: number;
      qualified: number;
      unknown: number;
      excluded: number;
    },
  ) {
    super(message);
    this.name = "CompetitiveDonorQualificationError";
  }
}

/** A sealed landscape failed its own post-seal invariant check. */
export class CompetitiveLandscapeInvalidError extends Error {
  readonly code = "COMPETITIVE_LANDSCAPE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CompetitiveLandscapeInvalidError";
  }
}

const DEFAULT_DONOR_COUNT = 10;

/** Per-domain qualification decision plus the evidence that produced it. */
export interface DomainQualificationRecord {
  domain: string;
  status: DonorQualification["status"];
  reason?: DomainExclusionReason | "operator_exclusion";
  rule: string;
  aggregate_visibility: number;
  distinct_query_count: number;
  best_rank: number;
}

/**
 * Reproducibility evidence for the integrity receipt. Deliberately NOT part of
 * the sealed payload — the shared contract owns that shape and SEO-Bot must not
 * invent protocol fields.
 */
export interface CompetitiveEvidenceSummary {
  seed_query_count: number;
  final_query_count: number;
  expansion_rounds_used: number;
  expansion_round_ceiling: number;
  expansion_query_ceiling: number;
  expansion_ceiling_reached: boolean;
  query_provenance: QueryProvenance[];
  serp_observation_count: number;
  candidate_domain_count: number;
  qualified_candidate_count: number;
  unknown_candidate_count: number;
  excluded_candidate_count: number;
  selected_donor_count: number;
  qualification_ledger: DomainQualificationRecord[];
  /** Structurally zero: this module imports no LLM service. */
  ranking_llm_calls: 0;
  /** Total DataForSEO provider attempts across all calls (requests are billable). */
  provider_attempts: number;
}

export interface CompetitiveLandscapeResult {
  artifact: CompetitiveLandscapeArtifact;
  evidence: CompetitiveEvidenceSummary;
}

/** visibility contribution of a single observation: weight × 1/log2(rank+1). */
function visibilityContribution(weight: number, rank: number): number {
  // rank is the organic position (>=1); log2(rank+1) is defined and > 0.
  return weight * (1 / Math.log2(rank + 1));
}

interface DomainAggregate {
  domain: string;
  visibility: number;
  queryIds: Set<string>;
  observationIds: string[];
  bestRank: number;
  firstSeenOrder: number;
}

type Observation = CompetitiveLandscapeV1["observations"][number];

/**
 * Build a CompetitiveLandscape artifact from live SERP evidence.
 * Deterministic: identical SERP responses (including their `observedAt`) yield
 * an identical sealed payload digest.
 */
export async function createCompetitiveLandscape(
  request: CompetitiveLandscapeRequest,
  deps: { dataForSeo?: DataForSeoOrganicPort } = {},
): Promise<CompetitiveLandscapeResult> {
  const dataForSeo = deps.dataForSeo ?? new DataForSeoClient();
  const desiredDonorCount = request.desired_donor_count ?? DEFAULT_DONOR_COUNT;
  const device = request.market.device ?? "desktop";
  const locationName = request.market.location_name ?? request.market.country;

  const operatorExclusions = new Set(
    (request.operator_exclusions ?? []).map(canonicalizeDomain).filter(Boolean),
  );

  let portfolio = buildSeedPortfolio(request.seed_queries);
  if (portfolio.queries.length === 0) {
    throw new CompetitiveEvidenceIncompleteError(
      "No usable seed queries: every supplied query was blank or duplicate.",
      {
        selected: 0,
        required: desiredDonorCount,
        qualified: 0,
        unknown: 0,
        excluded: 0,
        queries: 0,
        observations: 0,
        expansion_rounds_used: 0,
      },
    );
  }
  const seedQueryCount = portfolio.queries.length;

  // Observations accumulate across expansion rounds; a query is fetched once.
  const observations: Observation[] = [];
  const fetched = new Set<string>();
  let selection: DonorSelection | null = null;
  let expansionCeilingReached = false;

  for (;;) {
    await fetchPendingQueries(portfolio, fetched, observations, {
      dataForSeo,
      locationName,
      languageName: request.market.language,
      device,
    });

    selection = selectDonors(
      portfolio.queries,
      observations,
      operatorExclusions,
      desiredDonorCount,
    );
    if (selection.selected.length >= desiredDonorCount) break;

    const expanded = expandPortfolio(portfolio, request.market);
    if (!expanded) {
      expansionCeilingReached = true;
      break;
    }
    logger.info(
      {
        clientId: request.client_id,
        buildId: request.build_id,
        round: expanded.round,
        queriesBefore: portfolio.queries.length,
        queriesAfter: expanded.queries.length,
        qualifiedSoFar: selection.selected.length,
        required: desiredDonorCount,
      },
      "Donor cohort short of requirement; expanding query portfolio (bounded, deterministic)",
    );
    portfolio = expanded;
  }

  if (!selection) {
    throw new CompetitiveEvidenceIncompleteError(
      "Donor selection did not run after the query portfolio was built.",
      {
        selected: 0,
        required: desiredDonorCount,
        qualified: 0,
        unknown: 0,
        excluded: 0,
        queries: portfolio.queries.length,
        observations: observations.length,
        expansion_rounds_used: portfolio.round,
      },
    );
  }

  const evidence: CompetitiveEvidenceSummary = {
    seed_query_count: seedQueryCount,
    final_query_count: portfolio.queries.length,
    expansion_rounds_used: portfolio.round,
    expansion_round_ceiling: MAX_EXPANSION_ROUNDS,
    expansion_query_ceiling: MAX_PORTFOLIO_QUERIES,
    expansion_ceiling_reached: expansionCeilingReached,
    query_provenance: portfolio.provenance,
    serp_observation_count: observations.length,
    candidate_domain_count: selection.ledger.length,
    qualified_candidate_count: selection.qualified,
    unknown_candidate_count: selection.unknown,
    excluded_candidate_count: selection.excluded,
    selected_donor_count: selection.selected.length,
    qualification_ledger: selection.ledger,
    ranking_llm_calls: 0,
    provider_attempts: dataForSeo.providerAttempts ?? 0,
  };

  assertDonorCohort(selection, desiredDonorCount, evidence);

  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: {
      niche: request.market.niche,
      country: request.market.country,
      language: request.market.language,
      device,
      ...(request.market.location_name ? { location_name: request.market.location_name } : {}),
    },
    query_portfolio: portfolio.queries,
    observations,
    domains: selection.domains,
    selected_donors: selection.selected,
    exclusions: selection.exclusions,
    // True only because the hard invariant above already passed.
    evidence_complete: true,
    // Measured, not asserted: this module imports no LLM service (structural
    // proof), and the evidence summary records the literal zero.
    ranking_llm_calls: evidence.ranking_llm_calls,
  };

  assertPayloadInvariants(payload, desiredDonorCount);

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
      donors: selection.selected.length,
      required: desiredDonorCount,
      seedQueries: seedQueryCount,
      finalQueries: portfolio.queries.length,
      expansionRounds: portfolio.round,
      observations: observations.length,
      qualified: selection.qualified,
      unknown: selection.unknown,
      excluded: selection.excluded,
      artifactId: artifact.artifact_id,
    },
    "CompetitiveLandscape sealed",
  );

  return { artifact, evidence };
}

/**
 * Fetch every portfolio query that has not been fetched yet. A provider or task
 * failure is FATAL: the typed DataForSEO error propagates so the caller can
 * distinguish DATAFORSEO_UNAVAILABLE / DATAFORSEO_TASK_ERROR /
 * SERP_EVIDENCE_INVALID. A query that legitimately returns zero organic results
 * is recorded as zero observations — that is a valid empty result, not failure.
 */
async function fetchPendingQueries(
  portfolio: QueryPortfolio,
  fetched: Set<string>,
  observations: Observation[],
  ctx: {
    dataForSeo: DataForSeoOrganicPort;
    locationName: string;
    languageName: string;
    device: "desktop" | "mobile";
  },
): Promise<void> {
  for (const query of portfolio.queries) {
    if (fetched.has(query.query_id)) continue;
    let serp: OrganicSerpResult;
    try {
      serp = await ctx.dataForSeo.getOrganicSerp({
        keyword: query.query,
        locationName: ctx.locationName,
        languageName: ctx.languageName,
        device: ctx.device,
      });
    } catch (error) {
      logger.error(
        {
          queryId: query.query_id,
          query: query.query,
          error: error instanceof Error ? error.message : String(error),
        },
        "SERP evidence unavailable for a portfolio query; failing closed",
      );
      throw error;
    }
    fetched.add(query.query_id);

    // Deduplicate identical ranking URLs within one query: the same semantic
    // observation must never contribute visibility twice.
    const seenUrls = new Set<string>();
    let ordinal = 0;
    for (const item of serp.items) {
      const rank = item.rankGroup; // organic position only
      if (typeof rank !== "number" || rank < 1) continue;
      const canonical = canonicalizeDomain(item.domain || item.url);
      if (!canonical) continue;
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      ordinal += 1;
      observations.push({
        // Ordinal, not rank: two organic items can share a rank_group, and a
        // collided observation_id would silently drop donor lineage.
        observation_id: `${query.query_id}-o${ordinal}`,
        query_id: query.query_id,
        rank,
        url: item.url,
        domain: canonical,
        observed_at: serp.observedAt,
        source: "dataforseo",
      });
    }
  }
}

interface DonorSelection {
  domains: CompetitiveLandscapeV1["domains"];
  selected: CompetitiveLandscapeV1["selected_donors"];
  exclusions: CompetitiveLandscapeV1["exclusions"];
  ledger: DomainQualificationRecord[];
  qualified: number;
  unknown: number;
  excluded: number;
}

/**
 * Aggregate observations per normalized domain, qualify every candidate, and
 * select the top `desired` QUALIFIED domains by deterministic visibility.
 */
function selectDonors(
  queries: PortfolioQuery[],
  observations: Observation[],
  operatorExclusions: Set<string>,
  desired: number,
): DonorSelection {
  const weightByQueryId = new Map(queries.map((query) => [query.query_id, query.weight]));
  const aggregates = new Map<string, DomainAggregate>();
  let seenOrder = 0;

  for (const observation of observations) {
    const weight = weightByQueryId.get(observation.query_id) ?? 1;
    let aggregate = aggregates.get(observation.domain);
    if (!aggregate) {
      aggregate = {
        domain: observation.domain,
        visibility: 0,
        queryIds: new Set(),
        observationIds: [],
        bestRank: Number.POSITIVE_INFINITY,
        firstSeenOrder: seenOrder++,
      };
      aggregates.set(observation.domain, aggregate);
    }
    aggregate.visibility += visibilityContribution(weight, observation.rank);
    aggregate.queryIds.add(observation.query_id);
    aggregate.observationIds.push(observation.observation_id);
    if (observation.rank < aggregate.bestRank) aggregate.bestRank = observation.rank;
  }

  // Deterministic ordering for every downstream list: visibility desc, then
  // first-seen order asc, then domain asc.
  const ordered = [...aggregates.values()].sort(compareAggregates);

  const domains: CompetitiveLandscapeV1["domains"] = ordered.map((aggregate) => ({
    domain: aggregate.domain,
    aggregate_visibility: round(aggregate.visibility),
    qualifying_query_ids: [...aggregate.queryIds].sort(byCodeUnit),
    observation_ids: aggregate.observationIds,
  }));

  const exclusions: CompetitiveLandscapeV1["exclusions"] = [];
  const ledger: DomainQualificationRecord[] = [];
  const selected: CompetitiveLandscapeV1["selected_donors"] = [];
  let qualified = 0;
  let unknown = 0;
  let excluded = 0;

  for (const aggregate of ordered) {
    const base = {
      domain: aggregate.domain,
      aggregate_visibility: round(aggregate.visibility),
      distinct_query_count: aggregate.queryIds.size,
      best_rank: aggregate.bestRank,
    };

    if (operatorExclusions.has(aggregate.domain)) {
      exclusions.push({ domain: aggregate.domain, reason: "operator_exclusion" });
      ledger.push({
        ...base,
        status: "excluded",
        reason: "operator_exclusion",
        rule: "operator_exclusion",
      });
      excluded += 1;
      continue;
    }

    const verdict = qualifyDomain(aggregate.domain, {
      distinctQueryCount: aggregate.queryIds.size,
      bestRank: aggregate.bestRank,
    });

    if (verdict.status === "qualified") {
      qualified += 1;
      ledger.push({ ...base, status: "qualified", rule: verdict.rule });
      // Only QUALIFIED domains may occupy a donor position.
      if (selected.length < desired) {
        selected.push({
          domain: aggregate.domain,
          aggregate_visibility: round(aggregate.visibility),
          observation_ids: aggregate.observationIds,
        });
      }
      continue;
    }

    // Both EXCLUDED and UNKNOWN are recorded in the sealed exclusions ledger
    // with an accepted reason; UNKNOWN never counts toward the cohort.
    exclusions.push({ domain: aggregate.domain, reason: verdict.reason });
    ledger.push({ ...base, status: verdict.status, reason: verdict.reason, rule: verdict.rule });
    if (verdict.status === "unknown") unknown += 1;
    else excluded += 1;
  }

  // Operator exclusions that never surfaced in the SERP are still recorded, so
  // the artifact is an honest ledger of what the operator asked to remove.
  for (const domain of operatorExclusions) {
    if (!aggregates.has(domain)) {
      exclusions.push({ domain, reason: "operator_exclusion" });
    }
  }

  return { domains, selected, exclusions, ledger, qualified, unknown, excluded };
}

/**
 * THE hard artifact invariant. Fewer than `desired` qualified operating-company
 * donors is a failure — never a smaller cohort sealed as complete.
 */
function assertDonorCohort(
  selection: DonorSelection,
  desired: number,
  evidence: CompetitiveEvidenceSummary,
): void {
  if (selection.selected.length >= desired) return;

  const candidates = selection.ledger.length;
  // Enough of a market surfaced, but too little of it is an operating company.
  if (candidates >= desired) {
    throw new CompetitiveDonorQualificationError(
      `Only ${selection.selected.length} of ${desired} required donors qualify as operating companies ` +
        `(${candidates} candidate domains: ${selection.qualified} qualified, ${selection.unknown} unknown, ${selection.excluded} excluded).`,
      {
        selected: selection.selected.length,
        required: desired,
        candidates,
        qualified: selection.qualified,
        unknown: selection.unknown,
        excluded: selection.excluded,
      },
    );
  }

  throw new CompetitiveEvidenceIncompleteError(
    `Only ${selection.selected.length} of ${desired} required donors could be formed from ` +
      `${evidence.serp_observation_count} observation(s) across ${evidence.final_query_count} quer(ies) ` +
      `after ${evidence.expansion_rounds_used} bounded expansion round(s).`,
    {
      selected: selection.selected.length,
      required: desired,
      qualified: selection.qualified,
      unknown: selection.unknown,
      excluded: selection.excluded,
      queries: evidence.final_query_count,
      observations: evidence.serp_observation_count,
      expansion_rounds_used: evidence.expansion_rounds_used,
    },
  );
}

/**
 * Post-construction proof that the payload cannot lie: the cohort is exactly the
 * requested size, every donor is backed by real observations, and no donor also
 * appears in the exclusions ledger.
 */
function assertPayloadInvariants(payload: CompetitiveLandscapeV1, desired: number): void {
  if (payload.selected_donors.length !== desired) {
    throw new CompetitiveLandscapeInvalidError(
      `selected_donors=${payload.selected_donors.length} does not match the required cohort size ${desired}`,
    );
  }
  const observationIds = new Set(payload.observations.map((o) => o.observation_id));
  if (observationIds.size !== payload.observations.length) {
    throw new CompetitiveLandscapeInvalidError("observation_id collision in sealed observations");
  }
  const excludedDomains = new Set(payload.exclusions.map((exclusion) => exclusion.domain));
  for (const donor of payload.selected_donors) {
    if (donor.observation_ids.length === 0) {
      throw new CompetitiveLandscapeInvalidError(
        `selected donor ${donor.domain} has no supporting observations`,
      );
    }
    for (const id of donor.observation_ids) {
      if (!observationIds.has(id)) {
        throw new CompetitiveLandscapeInvalidError(
          `selected donor ${donor.domain} references unknown observation ${id}`,
        );
      }
    }
    if (excludedDomains.has(donor.domain)) {
      throw new CompetitiveLandscapeInvalidError(
        `selected donor ${donor.domain} also appears in the exclusions ledger`,
      );
    }
  }
  if (!payload.evidence_complete) {
    throw new CompetitiveLandscapeInvalidError(
      "evidence_complete must be true for a sealed landscape",
    );
  }
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
