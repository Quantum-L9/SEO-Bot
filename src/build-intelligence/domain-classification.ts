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
 * every exclusion WITH its reason. Ambiguous domains are RETAINED, never
 * silently discarded: certainty is not invented.
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

export type DomainQualificationStatus = "qualified" | "excluded" | "unknown";

export interface DomainQualification {
  status: DomainQualificationStatus;
  /** Present when status is excluded or unknown. `unknown` maps to schema reason `irrelevant`. */
  reason?: DomainExclusionReason;
}

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
  irrelevant: [],
};

/**
 * Hosting/platform/shortener properties. These are not operating companies and
 * are not on the structural exclusion lists, so qualification is UNKNOWN —
 * they must not occupy a required donor slot.
 */
const UNKNOWN_PLATFORM_HOSTS: readonly string[] = [
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "weebly.com",
  "webnode.com",
  "github.io",
  "bit.ly",
  "t.co",
  "goo.gl",
  "tinyurl.com",
];

function matches(domain: string, entry: string): boolean {
  return domain === entry || domain.endsWith(`.${entry}`);
}

/**
 * Classify a domain's donor eligibility. Returns the exclusion reason when the
 * domain is a known non-donor property, or `null` to RETAIN it (including every
 * ambiguous/unknown domain — the deliberate default).
 */
export function classifyDomain(domain: string): DomainExclusionReason | null {
  const canonical = canonicalizeDomain(domain);
  if (!canonical) return null;
  // Deterministic evaluation order (object key order is stable for these keys).
  for (const reason of Object.keys(CLASSIFICATION) as DomainExclusionReason[]) {
    if (CLASSIFICATION[reason].some((entry) => matches(canonical, entry))) {
      return reason;
    }
  }
  return null;
}

function isIpLiteral(domain: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain);
}

/**
 * Qualify a canonical domain for donor selection.
 *
 * - Known structural non-donors → excluded (do not occupy donor slots).
 * - Platform/hosting/shortener/IP → unknown (must not count toward the 10).
 * - Empty/unparseable → unknown.
 * - Otherwise → qualified operating-company candidate (exclude-list architecture).
 *
 * UNKNOWN never silently becomes QUALIFIED.
 */
export function qualifyDomain(domain: string): DomainQualification {
  const canonical = canonicalizeDomain(domain);
  if (!canonical) return { status: "unknown", reason: "irrelevant" };
  if (isIpLiteral(canonical)) return { status: "unknown", reason: "irrelevant" };
  if (UNKNOWN_PLATFORM_HOSTS.some((entry) => matches(canonical, entry))) {
    return { status: "unknown", reason: "irrelevant" };
  }
  const excluded = classifyDomain(canonical);
  if (excluded) return { status: "excluded", reason: excluded };
  return { status: "qualified" };
}
