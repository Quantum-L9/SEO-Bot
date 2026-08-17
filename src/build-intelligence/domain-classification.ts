/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deterministic domain normalization + donor-eligibility classification.
 *
 * Ranking truth is deterministic (no LLM). Donor selection must exclude domains
 * that are structurally unsuitable as design/content donors — social networks,
 * directories, marketplaces, publishers, and review aggregators — and record
 * every exclusion WITH its reason.
 *
 * Qualification is explicitly THREE-STATE. A domain that survives every
 * structural exclusion rule is still only QUALIFIED once the SERP evidence
 * corroborates it as an operating company in this market; otherwise it is
 * UNKNOWN. UNKNOWN never occupies a donor position and never silently becomes
 * QUALIFIED — certainty is not invented. Because the shared
 * `CompetitiveLandscapeV1` exclusion vocabulary has no UNKNOWN member (and
 * SEO-Bot must not invent protocol fields), an UNKNOWN candidate is recorded in
 * the sealed ledger under the accepted `irrelevant` reason, while the exact
 * deterministic rule travels in logs and the integrity receipt.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/** bot-interop CompetitiveLandscape exclusion reasons (excluding operator input). */
export type DomainExclusionReason =
  | "directory"
  | "social"
  | "marketplace"
  | "publisher"
  | "aggregator"
  | "irrelevant";

/**
 * Canonicalize a URL or hostname to a bare registrable-ish domain:
 *   `https://www.Example.com/foo?x=1` → `example.com`
 *   `www.example.com.`               → `example.com`
 * Deterministic and idempotent. Never throws — an unparseable input is
 * lowercased/trimmed and returned so it can still be compared and recorded.
 */
export function canonicalizeDomain(input: string): string {
  let value = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  // Strip scheme + any path/query/fragment by parsing as a URL when possible.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      value = value.slice(value.indexOf("://") + 3);
    }
  }
  // Drop path/query/port that survive when there was no scheme.
  value = value.split("/")[0]!.split("?")[0]!.split("#")[0]!.split(":")[0]!;
  value = value.replace(/^www\./, "").replace(/\.$/, "");
  return value;
}

/**
 * Curated donor-ineligibility lists. Matching is by exact canonical domain or
 * by registrable-suffix (so `m.facebook.com` and `facebook.com` both match).
 * These are intentionally conservative — only well-known non-donor properties.
 */
const CLASSIFICATION: Record<DomainExclusionReason, readonly string[]> = {
  social: [
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "linkedin.com",
    "youtube.com",
    "tiktok.com",
    "pinterest.com",
    "reddit.com",
    "quora.com",
    "nextdoor.com",
    "threads.net",
  ],
  directory: [
    "yelp.com",
    "yellowpages.com",
    "bbb.org",
    "angi.com",
    "angieslist.com",
    "thumbtack.com",
    "houzz.com",
    "manta.com",
    "foursquare.com",
    "mapquest.com",
    "superpages.com",
    "chamberofcommerce.com",
    "google.com",
    "bing.com",
  ],
  marketplace: [
    "amazon.com",
    "ebay.com",
    "etsy.com",
    "walmart.com",
    "alibaba.com",
    "homeadvisor.com",
    "fiverr.com",
    "upwork.com",
  ],
  publisher: [
    "forbes.com",
    "nytimes.com",
    "wikipedia.org",
    "medium.com",
    "wikihow.com",
    "businessinsider.com",
    "huffpost.com",
    "entrepreneur.com",
    "inc.com",
  ],
  aggregator: [
    "tripadvisor.com",
    "trustpilot.com",
    "g2.com",
    "capterra.com",
    "clutch.co",
    "sitejabber.com",
    "consumeraffairs.com",
    "expertise.com",
    "birdeye.com",
  ],
  // Populated by the structural rules below rather than by an exact-match list.
  irrelevant: [],
};

/**
 * Suffixes that are never an operating company's commercial site. Matched on the
 * canonical domain's tail, so `city.dallas.gov` and `dallas.gov` both match.
 */
const NON_COMMERCIAL_SUFFIXES: readonly string[] = [
  ".gov",
  ".mil",
  ".edu",
  ".gov.uk",
  ".ac.uk",
  ".nhs.uk",
  ".gov.au",
  ".edu.au",
  ".gc.ca",
  ".gov.ca",
];

/**
 * Hosted site-builder / blogging platforms. A page on one of these is a tenant
 * of the platform, not an independent operating-company domain, so it cannot be
 * a design/content donor even when the tenant is a genuine local business.
 */
const HOSTED_PLATFORM_SUFFIXES: readonly string[] = [
  "wordpress.com",
  "blogspot.com",
  "wixsite.com",
  "weebly.com",
  "squarespace.com",
  "godaddysites.com",
  "business.site",
  "myshopify.com",
  "substack.com",
  "github.io",
  "tumblr.com",
  "webflow.io",
  "netlify.app",
  "vercel.app",
  "sites.google.com",
];

/**
 * Lexical directory/aggregator markers in the domain label itself. Intentionally
 * narrow — a real operating company can legitimately be called "bestroofing.com",
 * so only unambiguous listing-site tokens appear here.
 */
const DIRECTORY_NAME_MARKERS: readonly string[] = [
  "directory",
  "directories",
  "yellowpages",
  "whitepages",
  "businesslistings",
  "listingsof",
  "top10",
  "top-10",
  "bestof",
  "best-of",
];

function matches(domain: string, entry: string): boolean {
  return domain === entry || domain.endsWith(`.${entry}`);
}

/**
 * Structural exclusion pass: is this domain a known or structurally-evident
 * non-donor property? Returns the exclusion reason, or `null` when the domain
 * survives every structural rule (which is NOT yet the same as qualified).
 */
export function classifyDomain(domain: string): DomainExclusionReason | null {
  return structuralExclusion(domain)?.reason ?? null;
}

/** Structural exclusion with the exact deterministic rule that fired. */
export function structuralExclusion(
  domain: string,
): { reason: DomainExclusionReason; rule: string } | null {
  const canonical = canonicalizeDomain(domain);
  if (!canonical) return null;

  // 1. Curated non-donor properties (deterministic key order).
  for (const reason of Object.keys(CLASSIFICATION) as DomainExclusionReason[]) {
    if (CLASSIFICATION[reason].some((entry) => matches(canonical, entry))) {
      return { reason, rule: `curated_list:${reason}` };
    }
  }
  // 2. Non-commercial suffixes (government, military, academic, health service).
  for (const suffix of NON_COMMERCIAL_SUFFIXES) {
    if (canonical === suffix.slice(1) || canonical.endsWith(suffix)) {
      return { reason: "irrelevant", rule: `non_commercial_suffix:${suffix}` };
    }
  }
  // 3. Tenant of a hosted site-builder / blogging platform.
  for (const platform of HOSTED_PLATFORM_SUFFIXES) {
    if (matches(canonical, platform)) {
      return { reason: "irrelevant", rule: `hosted_platform:${platform}` };
    }
  }
  // 4. Unambiguous listing-site tokens in the domain label.
  const label = canonical.split(".")[0] ?? "";
  for (const marker of DIRECTORY_NAME_MARKERS) {
    if (label.includes(marker)) {
      return { reason: "directory", rule: `directory_name_marker:${marker}` };
    }
  }
  return null;
}

/* ── Three-state donor qualification ────────────────────────────────────────── */

/**
 * Minimum distinct portfolio queries a domain must rank for before the SERP
 * evidence corroborates it as an operating company in this market.
 */
export const QUALIFICATION_MIN_DISTINCT_QUERIES = 2;
/**
 * A single strong placement is corroboration on its own: a domain in the top
 * `QUALIFICATION_STRONG_RANK` organic positions for a portfolio query is an
 * established competitor even when it appears for only that one query.
 */
export const QUALIFICATION_STRONG_RANK = 10;

/** Deterministic evidence inputs for the corroboration rule. */
export interface DomainMarketEvidence {
  /** How many distinct `query_id`s this domain ranked for. */
  distinctQueryCount: number;
  /** Best (lowest) organic rank observed across the portfolio. */
  bestRank: number;
}

export type DonorQualification =
  | { status: "qualified"; rule: string }
  | { status: "excluded"; reason: DomainExclusionReason; rule: string }
  | { status: "unknown"; reason: "irrelevant"; rule: string };

/**
 * Qualify a domain as a donor candidate. Structural exclusions win first; a
 * surviving domain is QUALIFIED only when the SERP evidence corroborates it,
 * and UNKNOWN otherwise. UNKNOWN is never counted toward the donor cohort.
 */
export function qualifyDomain(domain: string, evidence: DomainMarketEvidence): DonorQualification {
  const excluded = structuralExclusion(domain);
  if (excluded) return { status: "excluded", ...excluded };

  if (evidence.distinctQueryCount >= QUALIFICATION_MIN_DISTINCT_QUERIES) {
    return {
      status: "qualified",
      rule: `market_corroboration:distinct_queries>=${QUALIFICATION_MIN_DISTINCT_QUERIES}`,
    };
  }
  if (evidence.bestRank >= 1 && evidence.bestRank <= QUALIFICATION_STRONG_RANK) {
    return {
      status: "qualified",
      rule: `market_corroboration:best_rank<=${QUALIFICATION_STRONG_RANK}`,
    };
  }
  return {
    status: "unknown",
    reason: "irrelevant",
    rule: "insufficient_market_corroboration",
  };
}
