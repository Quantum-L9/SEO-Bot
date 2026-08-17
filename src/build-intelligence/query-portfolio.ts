/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deterministic query portfolio + bounded expansion (ZERO LLM).
 *
 * The initial portfolio is a pure function of the request: normalize, dedupe,
 * assign stable `query_id`s and deterministic weights. When the seed portfolio
 * cannot yield the required qualified donor cohort, the portfolio is EXPANDED —
 * deterministically, from the supplied seeds and market context only, in bounded
 * rounds, with the origin rule recorded for every added query.
 *
 * No LLM invents queries here. Identical requests always produce an identical
 * portfolio (and an identical expansion sequence), so the sealed
 * CompetitiveLandscape digest stays reproducible.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { CompetitiveLandscapeV1 } from "@quantum-l9/bot-interop";

export type QueryIntent = CompetitiveLandscapeV1["query_portfolio"][number]["intent"];
export type PortfolioQuery = CompetitiveLandscapeV1["query_portfolio"][number];

export interface SeedQueryInput {
  query: string;
  intent: QueryIntent;
  weight?: number;
}

export interface MarketContext {
  niche: string;
  country: string;
  language: string;
  location_name?: string;
}

/** Where a portfolio query came from — the reproducibility ledger. */
export interface QueryProvenance {
  query_id: string;
  query: string;
  origin: "seed" | "expansion";
  /** 0 for seeds; 1..MAX_EXPANSION_ROUNDS for expansion queries. */
  expansion_round: number;
  /** Deterministic rule that produced the query ("seed" for seeds). */
  rule: string;
  /** Normalized parent query text for expansion queries. */
  derived_from?: string;
}

export interface QueryPortfolio {
  queries: PortfolioQuery[];
  provenance: QueryProvenance[];
  /** Highest expansion round reached so far (0 === seeds only). */
  round: number;
}

/** Hard bounds. Expansion can never run away, and every bound is reported. */
export const MAX_EXPANSION_ROUNDS = 3;
export const MAX_PORTFOLIO_QUERIES = 24;
/** Each expansion round's queries carry this fraction of their parent's weight. */
export const EXPANSION_WEIGHT_DECAY = 0.5;

/** Normalize query text: trim, collapse whitespace, lowercase. Deterministic. */
export function normalizeQueryText(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function queryId(index: number): string {
  return `q${index + 1}`;
}

/** Round weights so floating-point noise never perturbs the canonical digest. */
function roundWeight(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Build the deterministic seed portfolio. Blank queries are dropped, duplicates
 * collapse to their first occurrence, and a missing/invalid weight defaults to 1.
 */
export function buildSeedPortfolio(seeds: SeedQueryInput[]): QueryPortfolio {
  const queries: PortfolioQuery[] = [];
  const provenance: QueryProvenance[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    const query = normalizeQueryText(seed.query);
    if (!query || seen.has(query)) continue;
    seen.add(query);
    const id = queryId(queries.length);
    const weight =
      typeof seed.weight === "number" && Number.isFinite(seed.weight) && seed.weight > 0
        ? roundWeight(seed.weight)
        : 1;
    queries.push({ query_id: id, query, intent: seed.intent, weight });
    provenance.push({ query_id: id, query, origin: "seed", expansion_round: 0, rule: "seed" });
  }

  return { queries, provenance, round: 0 };
}

interface ExpansionRule {
  rule: string;
  intent: QueryIntent;
  /** Returns the expanded query text, or null when the rule does not apply. */
  derive(parent: PortfolioQuery, market: MarketContext): string | null;
}

/**
 * Expansion dimensions, applied in this exact order. Every rule is a pure
 * function of a seed query plus the supplied market context — nothing is
 * invented from outside the request.
 */
const EXPANSION_ROUNDS: ReadonlyArray<readonly ExpansionRule[]> = [
  // Round 1 — operating-company variants. Surfaces companies rather than
  // informational pages for the same service.
  [
    { rule: "company_variant", intent: "commercial", derive: (p) => `${p.query} company` },
    { rule: "contractor_variant", intent: "commercial", derive: (p) => `${p.query} contractor` },
    { rule: "services_variant", intent: "commercial", derive: (p) => `${p.query} services` },
  ],
  // Round 2 — geography, from the market context the caller supplied.
  [
    {
      rule: "location_variant",
      intent: "local",
      derive: (p, market) => {
        const place = normalizeQueryText(market.location_name ?? market.country);
        return place ? `${p.query} ${place}` : null;
      },
    },
    { rule: "near_me_variant", intent: "local", derive: (p) => `${p.query} near me` },
  ],
  // Round 3 — transactional/commercial-investigation intent.
  [
    { rule: "cost_variant", intent: "transactional", derive: (p) => `${p.query} cost` },
    { rule: "quote_variant", intent: "transactional", derive: (p) => `${p.query} quote` },
    { rule: "best_variant", intent: "commercial", derive: (p) => `best ${p.query}` },
  ],
];

/**
 * Expand the portfolio by exactly one round. Returns the same portfolio object
 * shape with the round's queries appended, capped at MAX_PORTFOLIO_QUERIES.
 * Returns `null` when no further expansion is possible (round ceiling reached,
 * query ceiling reached, or the round produced nothing new).
 */
export function expandPortfolio(
  portfolio: QueryPortfolio,
  market: MarketContext,
): QueryPortfolio | null {
  const nextRound = portfolio.round + 1;
  if (nextRound > MAX_EXPANSION_ROUNDS) return null;
  if (portfolio.queries.length >= MAX_PORTFOLIO_QUERIES) return null;

  const rules = EXPANSION_ROUNDS[nextRound - 1];
  if (!rules) return null;

  // Only SEED queries parent an expansion — expansions never compound, which is
  // what keeps the growth linear and the ceiling meaningful.
  const seedIds = new Set(
    portfolio.provenance.filter((entry) => entry.origin === "seed").map((entry) => entry.query_id),
  );
  const parents = portfolio.queries.filter((query) => seedIds.has(query.query_id));

  const queries = [...portfolio.queries];
  const provenance = [...portfolio.provenance];
  const seen = new Set(queries.map((query) => query.query));
  let added = 0;

  for (const rule of rules) {
    for (const parent of parents) {
      if (queries.length >= MAX_PORTFOLIO_QUERIES) break;
      const derived = normalizeQueryText(rule.derive(parent, market) ?? "");
      if (!derived || seen.has(derived)) continue;
      seen.add(derived);
      const id = queryId(queries.length);
      queries.push({
        query_id: id,
        query: derived,
        intent: rule.intent,
        weight: roundWeight(parent.weight * EXPANSION_WEIGHT_DECAY ** nextRound),
      });
      provenance.push({
        query_id: id,
        query: derived,
        origin: "expansion",
        expansion_round: nextRound,
        rule: rule.rule,
        derived_from: parent.query,
      });
      added += 1;
    }
  }

  if (added === 0) return null;
  return { queries, provenance, round: nextRound };
}
