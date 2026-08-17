/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * Deterministic, bounded query-portfolio expansion.
 *
 * Used only when the initial seed portfolio cannot produce 10 qualified
 * operating-company donors. No LLM. Weights are never invented per-query:
 * expanded queries inherit the default weight of 1 (same as an unspecified
 * seed weight).
 */

export const MAX_EXPANSION_ROUNDS = 2;
export const MAX_ADDED_QUERIES = 12;
export const HARD_EXPANSION_CEILING = MAX_ADDED_QUERIES;

export type QueryIntent = "informational" | "commercial" | "transactional" | "local";

export interface SeedQuery {
  query: string;
  intent: QueryIntent;
  weight?: number;
}

export interface PortfolioQuery {
  query_id: string;
  query: string;
  intent: QueryIntent;
  weight: number;
}

export interface ExpansionRecord {
  query_id: string;
  query: string;
  intent: QueryIntent;
  weight: number;
  reason: string;
  round: number;
}

export function normalizeQueryText(query: string): string {
  return String(query ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function defaultQueryWeight(weight: number | undefined): number {
  return typeof weight === "number" && weight > 0 ? weight : 1;
}

export function initialPortfolio(seeds: SeedQuery[]): PortfolioQuery[] {
  return seeds.map((seed, index) => ({
    query_id: `q${index + 1}`,
    query: seed.query.trim(),
    intent: seed.intent,
    weight: defaultQueryWeight(seed.weight),
  }));
}

function locationPhrase(market: {
  country: string;
  location_name?: string;
}): string | undefined {
  const raw = (market.location_name ?? market.country ?? "").trim();
  if (!raw) return undefined;
  const first = raw.split(",")[0]!.trim();
  if (!first || first.toLowerCase() === "us" || first.toLowerCase() === "united states") {
    return undefined;
  }
  return first;
}

function nichePhrase(niche: string): string {
  return niche.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

interface ExpansionTemplate {
  query: string;
  intent: QueryIntent;
  reason: string;
}

function templatesForRound(
  round: number,
  niche: string,
  location: string | undefined,
  originalQueries: string[],
): ExpansionTemplate[] {
  if (round === 1) {
    const core: ExpansionTemplate[] = [
      { query: niche, intent: "commercial", reason: "core_service_variant" },
      { query: `${niche} company`, intent: "commercial", reason: "core_service_variant" },
      { query: `${niche} contractor`, intent: "transactional", reason: "transaction_commercial_variant" },
      { query: `${niche} near me`, intent: "local", reason: "transaction_commercial_variant" },
      { query: `hire ${niche}`, intent: "transactional", reason: "transaction_commercial_variant" },
    ];
    if (location) {
      core.push(
        { query: `${location} ${niche}`, intent: "local", reason: "geography_variant" },
        { query: `${niche} ${location}`, intent: "local", reason: "geography_variant" },
      );
    }
    return core;
  }

  const highValue: ExpansionTemplate[] = [
    { query: `best ${niche}`, intent: "commercial", reason: "high_value_service_variant" },
    { query: `${niche} cost`, intent: "commercial", reason: "high_value_service_variant" },
    { query: `${niche} services`, intent: "commercial", reason: "core_service_variant" },
  ];
  for (const seed of originalQueries) {
    highValue.push(
      { query: `${seed} company`, intent: "commercial", reason: "adjacent_search_intent_variant" },
      { query: `${seed} near me`, intent: "local", reason: "adjacent_search_intent_variant" },
      { query: `${seed} contractor`, intent: "transactional", reason: "adjacent_search_intent_variant" },
    );
  }
  return highValue;
}

/**
 * Plan the next expansion round. Returns [] when the ceiling is reached or
 * every remaining template is a duplicate of an already-collected query.
 */
export function planExpansionRound(args: {
  round: number;
  niche: string;
  market: { country: string; location_name?: string };
  existingQueries: string[];
  originalQueries: string[];
  addedSoFar: number;
}): ExpansionRecord[] {
  if (args.round < 1 || args.round > MAX_EXPANSION_ROUNDS) return [];
  if (args.addedSoFar >= MAX_ADDED_QUERIES) return [];

  const niche = nichePhrase(args.niche);
  if (!niche) return [];
  const location = locationPhrase(args.market);
  const seen = new Set(args.existingQueries.map(normalizeQueryText));
  const planned: ExpansionRecord[] = [];

  for (const template of templatesForRound(args.round, niche, location, args.originalQueries)) {
    if (args.addedSoFar + planned.length >= MAX_ADDED_QUERIES) break;
    const normalized = normalizeQueryText(template.query);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    planned.push({
      query_id: `x${args.round}-${planned.length + 1}`,
      query: template.query,
      intent: template.intent,
      weight: 1,
      reason: template.reason,
      round: args.round,
    });
  }
  return planned;
}
