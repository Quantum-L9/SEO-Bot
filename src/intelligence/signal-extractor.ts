/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Signal Extractors (ADR-0016)
 *
 * The Observe→Diagnose step. Each extractor is one deterministic SQL question
 * asked on a schedule, turning raw module output into normalized signals.
 *
 * Two deliberate choices:
 *
 *   1. Several extractors read the `reporting` views rather than re-deriving
 *      "latest row per entity" windows inline. The reporting plane already owns
 *      those semantics; a second, drifting copy of them inside the bot is how
 *      the operator's dashboard and the bot's own reasoning end up disagreeing
 *      about what happened.
 *
 *   2. Every extractor is split into a SQL half and a pure `mapRow` half. The
 *      mapping — severity thresholds, confidence, fingerprint, grouping key — is
 *      where the judgment lives, so it is the part that must be unit-testable
 *      without a database.
 *
 * Zero tokens. No LLM is involved in extraction.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { type SQL, sql } from "drizzle-orm";
import { getDb } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import {
  normalizePageKey,
  type SignalCandidate,
  type SignalSeverity,
  type SignalType,
  signalFingerprint,
} from "./types.js";

const logger = createModuleLogger("intelligence:signals");

type Row = Record<string, unknown>;

export interface SignalExtractor {
  readonly signalType: SignalType;
  readonly description: string;
  /** Parameterized query for one tenant. */
  readonly query: (clientId: string) => SQL;
  /** Pure: row → signal. Returns null when the row does not clear the bar. */
  readonly mapRow: (row: Row, clientId: string) => SignalCandidate | null;
}

// ─── Row coercion ────────────────────────────────────────────────────────────
// pg returns numeric/bigint as strings to avoid precision loss, so every numeric
// read goes through these rather than trusting the driver's JS type.

export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * The first rung whose bound `value` meets, highest first, else `fallback`.
 *
 * Every severity and confidence decision here is a threshold ladder. Written
 * as a ternary chain it reads as nested conditions (typescript:S3358) and the
 * bounds get lost in the punctuation; as data the ordering is visible and the
 * rungs can be read straight down.
 */
function byThreshold<T>(
  value: number,
  ladder: ReadonlyArray<readonly [number, T]>,
  fallback: T,
): T {
  for (const [bound, result] of ladder) {
    if (value >= bound) return result;
  }
  return fallback;
}

/**
 * One signal candidate.
 *
 * Named fields rather than eight positional parameters (typescript:S107):
 * three of them were adjacent strings — clientId, entityId, groupKey — which a
 * caller could transpose with no type error and no test failure, since the
 * fingerprint would still be well-formed and would simply describe a different
 * signal.
 */
interface SignalDraft {
  clientId: string;
  signalType: SignalType;
  entityType: SignalCandidate["entityType"];
  entityId: string;
  severity: SignalSeverity;
  confidence: number;
  evidence: Record<string, unknown>;
  groupKey: string;
}

function build({
  clientId,
  signalType,
  entityType,
  entityId,
  severity,
  confidence,
  evidence,
  groupKey,
}: SignalDraft): SignalCandidate {
  return {
    clientId,
    entityType,
    entityId,
    signalType,
    severity,
    confidence,
    evidence,
    fingerprint: signalFingerprint(clientId, signalType, entityId),
    groupKey,
  };
}

// ─── Extractors ──────────────────────────────────────────────────────────────

/** A tracked keyword lost five or more positions in the last seven days. */
export const keywordDropExtractor: SignalExtractor = {
  signalType: "keyword_drop",
  description: "Keywords that lost five or more positions in the last seven days.",
  query: (clientId) => sql`
    SELECT keyword, device, previous_position, current_position, position_delta, url, checked_at
    FROM reporting.keyword_drops_7d
    WHERE client_id = ${clientId}::uuid
    ORDER BY position_delta DESC
    LIMIT 100
  `,
  mapRow: (row, clientId) => {
    const keyword = asString(row.keyword);
    const delta = asNumber(row.position_delta);
    if (!keyword || delta === null || delta < 5) return null;

    const severity: SignalSeverity = delta >= 10 ? "high" : "medium";
    const url = asString(row.url);
    const pageKey = normalizePageKey(url);

    return build({
      clientId,
      signalType: "keyword_drop",
      entityType: "keyword",
      entityId: keyword,
      severity,
      confidence: 0.85,
      evidence: {
        keyword,
        device: asString(row.device),
        current_position: asNumber(row.current_position),
        previous_position: asNumber(row.previous_position),
        position_delta: delta,
        url,
        page_path: pageKey,
        checked_at: asString(row.checked_at),
      },
      // Group on the ranking page when we know it, so a ranking drop and a page
      // experience problem on the same URL become ONE opportunity.
      groupKey: pageKey ?? `keyword:${keyword}`,
    });
  },
};

/** A page where visitors leave AND the page is slow — the compound failure. */
export const pageExperienceExtractor: SignalExtractor = {
  signalType: "high_exit_bad_lcp",
  description: "Pages combining a high exit rate with poor Largest Contentful Paint.",
  query: (clientId) => sql`
    SELECT page_path, period, exit_rate, bounce_rate, avg_scroll_depth,
           total_pageviews, device, lcp, inp, cls, risk_level, measured_at
    FROM reporting.page_experience_risks
    WHERE client_id = ${clientId}::uuid
      AND risk_level IN ('critical', 'high')
    ORDER BY total_pageviews DESC NULLS LAST
    LIMIT 50
  `,
  mapRow: (row, clientId) => {
    const pagePath = normalizePageKey(asString(row.page_path));
    if (!pagePath) return null;

    const riskLevel = asString(row.risk_level);
    const severity: SignalSeverity = riskLevel === "critical" ? "critical" : "high";
    const pageviews = asNumber(row.total_pageviews) ?? 0;

    return build({
      clientId,
      signalType: "high_exit_bad_lcp",
      entityType: "page",
      entityId: pagePath,
      severity,
      // A judgment on a handful of sessions is a judgment on noise. Traffic
      // volume is the only thing separating a real pattern from three visitors.
      confidence: byThreshold(
        pageviews,
        [
          [100, 0.9],
          [20, 0.7],
        ],
        0.45,
      ),
      evidence: {
        page_path: pagePath,
        period: asString(row.period),
        exit_rate: asNumber(row.exit_rate),
        bounce_rate: asNumber(row.bounce_rate),
        avg_scroll_depth: asNumber(row.avg_scroll_depth),
        total_pageviews: pageviews,
        device: asString(row.device),
        lcp: asNumber(row.lcp),
        inp: asNumber(row.inp),
        cls: asNumber(row.cls),
        risk_level: riskLevel,
      },
      groupKey: pagePath,
    });
  },
};

/** LCP got materially worse versus the preceding fortnight. */
export const lcpRegressionExtractor: SignalExtractor = {
  signalType: "lcp_regression",
  description: "Pages whose LCP regressed materially against their own recent baseline.",
  query: (clientId) => sql`
    WITH latest AS (
      SELECT DISTINCT ON (reporting.path_from_url(url), COALESCE(device, 'mobile'))
             reporting.path_from_url(url) AS page_path,
             COALESCE(device, 'mobile') AS device,
             lcp,
             measured_at
      FROM web_vitals
      WHERE client_id = ${clientId}::uuid
        AND lcp IS NOT NULL
        AND measured_at >= now() - interval '3 days'
      ORDER BY reporting.path_from_url(url), COALESCE(device, 'mobile'), measured_at DESC
    ),
    baseline AS (
      SELECT reporting.path_from_url(url) AS page_path,
             COALESCE(device, 'mobile') AS device,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY lcp) AS baseline_lcp,
             count(*) AS samples
      FROM web_vitals
      WHERE client_id = ${clientId}::uuid
        AND lcp IS NOT NULL
        AND measured_at <  now() - interval '3 days'
        AND measured_at >= now() - interval '17 days'
      GROUP BY 1, 2
      HAVING count(*) >= 3
    )
    SELECT l.page_path, l.device, l.lcp AS current_lcp, b.baseline_lcp, b.samples, l.measured_at
    FROM latest l
    JOIN baseline b ON b.page_path = l.page_path AND b.device = l.device
    WHERE b.baseline_lcp > 0
      AND l.lcp >= 2500
      AND l.lcp >= b.baseline_lcp * 1.2
    ORDER BY (l.lcp - b.baseline_lcp) DESC
    LIMIT 50
  `,
  mapRow: (row, clientId) => {
    const pagePath = normalizePageKey(asString(row.page_path));
    const currentLcp = asNumber(row.current_lcp);
    const baselineLcp = asNumber(row.baseline_lcp);
    if (!pagePath || currentLcp === null || baselineLcp === null || baselineLcp <= 0) return null;

    const ratio = currentLcp / baselineLcp;
    const severity: SignalSeverity = ratio >= 1.5 ? "high" : "medium";
    const samples = asNumber(row.samples) ?? 0;

    return build({
      clientId,
      signalType: "lcp_regression",
      entityType: "page",
      entityId: pagePath,
      severity,
      confidence: samples >= 10 ? 0.85 : 0.65,
      evidence: {
        page_path: pagePath,
        device: asString(row.device),
        current_lcp: currentLcp,
        baseline_lcp: Math.round(baselineLcp),
        regression_ratio: Math.round(ratio * 100) / 100,
        baseline_samples: samples,
        measured_at: asString(row.measured_at),
      },
      groupKey: pagePath,
    });
  },
};

/** Answer-engine citation rate fell month over month on a platform. */
export const citationRateExtractor: SignalExtractor = {
  signalType: "citation_rate_down",
  description: "Platforms whose answer-engine citation rate fell against the previous month.",
  query: (clientId) => sql`
    WITH monthly AS (
      SELECT platform,
             date_trunc('month', checked_at)::date AS month,
             count(*) AS queries_checked,
             count(*) FILTER (WHERE cited) AS cited_count,
             100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0) AS rate_pct
      FROM aeo_citations
      WHERE client_id = ${clientId}::uuid
        AND checked_at >= date_trunc('month', now()) - interval '1 month'
      GROUP BY 1, 2
      HAVING count(*) >= 3
    )
    SELECT c.platform,
           c.month,
           c.queries_checked,
           c.cited_count,
           round(c.rate_pct, 2) AS current_rate_pct,
           round(p.rate_pct, 2) AS previous_rate_pct
    FROM monthly c
    JOIN monthly p
      ON p.platform = c.platform
     AND p.month = (c.month - interval '1 month')::date
    WHERE c.month = date_trunc('month', now())::date
      AND c.rate_pct < p.rate_pct - 10
  `,
  mapRow: (row, clientId) => {
    const platform = asString(row.platform);
    const current = asNumber(row.current_rate_pct);
    const previous = asNumber(row.previous_rate_pct);
    if (!platform || current === null || previous === null) return null;

    const dropPoints = previous - current;
    const severity: SignalSeverity = dropPoints >= 30 ? "high" : "medium";
    const checked = asNumber(row.queries_checked) ?? 0;

    return build({
      clientId,
      signalType: "citation_rate_down",
      entityType: "platform",
      entityId: platform,
      severity,
      confidence: checked >= 10 ? 0.8 : 0.6,
      evidence: {
        platform,
        current_rate_pct: current,
        previous_rate_pct: previous,
        drop_points: Math.round(dropPoints * 100) / 100,
        queries_checked: checked,
        cited_count: asNumber(row.cited_count),
      },
      groupKey: `platform:${platform}`,
    });
  },
};
/**
 * A competitor is being cited on queries where the client is not.
 *
 * Emitted at TWO scopes from one pass over the same rows, because the same
 * observation answers two different questions:
 *
 * - `platform` — "on perplexity, rival.example is cited instead of us" —
 *   groups on `platform:<name>`, which is what `answer_engine_gap` targets.
 * - `keyword` — "on the query 'roof repair austin', which ALSO lost SERP
 *   position this week, rival.example is cited instead of us" — groups on the
 *   same key `keywordDropExtractor` uses (the ranking page, else
 *   `keyword:<kw>`), which is what lets `serp_and_answer_engine_loss` form.
 *
 * The keyword scope is why that compound diagnosis is reachable at all. Before
 * it, both citation extractors keyed on `platform:` and `keyword_drop` keyed on
 * a page or keyword, so the two rules requiring them in ONE group could never
 * match and the plane silently produced the two single-symptom diagnoses
 * instead (TODO.md §3). `aeo_citations` always carried the per-row `query`
 * dimension needed for the join; only the per-platform rollup discarded it.
 *
 * The scopes deliberately OVERLAP: a citation lost on a dropping keyword counts
 * toward its platform's aggregate as well. Excluding it would silently weaken
 * `answer_engine_gap`, which is a real signal about overall answer-engine
 * presence, to make a bookkeeping property true.
 */
export const competitorCitationExtractor: SignalExtractor = {
  signalType: "competitor_citation_gain",
  description: "Queries where a competitor is cited by an answer engine and the client is not.",
  query: (clientId) => sql`
    WITH uncited AS (
      SELECT lower(btrim(query)) AS keyword_key, query, platform, competitor_cited, checked_at
      FROM aeo_citations
      WHERE client_id = ${clientId}::uuid
        AND cited = false
        AND competitor_cited IS NOT NULL
        AND checked_at >= now() - interval '30 days'
    ),
    dropped AS (
      SELECT lower(btrim(keyword)) AS keyword_key,
             min(keyword) AS keyword,
             max(position_delta)::numeric AS position_delta,
             (array_agg(url ORDER BY position_delta DESC) FILTER (WHERE url IS NOT NULL))[1] AS url
      FROM reporting.keyword_drops_7d
      WHERE client_id = ${clientId}::uuid
      GROUP BY 1
    ),
    by_platform AS (
      SELECT 'platform'::text AS scope,
             platform,
             competitor_cited,
             count(*) AS occurrences,
             max(checked_at) AS last_seen,
             (array_agg(query ORDER BY checked_at DESC))[1:3] AS sample_queries,
             NULL::text AS keyword,
             NULL::text AS url,
             NULL::numeric AS position_delta
      FROM uncited
      GROUP BY platform, competitor_cited
      HAVING count(*) >= 2
    ),
    by_keyword AS (
      SELECT 'keyword'::text AS scope,
             u.platform,
             u.competitor_cited,
             count(*) AS occurrences,
             max(u.checked_at) AS last_seen,
             (array_agg(u.query ORDER BY u.checked_at DESC))[1:3] AS sample_queries,
             d.keyword,
             d.url,
             d.position_delta
      FROM uncited u
      JOIN dropped d ON d.keyword_key = u.keyword_key
      GROUP BY u.platform, u.competitor_cited, d.keyword, d.url, d.position_delta
      HAVING count(*) >= 2
    )
    SELECT * FROM by_platform
    UNION ALL
    SELECT * FROM by_keyword
    ORDER BY occurrences DESC
    LIMIT 50
  `,
  mapRow: (row, clientId) => {
    const platform = asString(row.platform);
    const competitor = asString(row.competitor_cited);
    const occurrences = asNumber(row.occurrences) ?? 0;
    if (!platform || !competitor || occurrences < 2) return null;

    const severity: SignalSeverity = occurrences >= 5 ? "high" : "medium";
    const sampleQueries = Array.isArray(row.sample_queries)
      ? (row.sample_queries as unknown[]).map(asString).filter((q): q is string => q !== null)
      : [];
    const lastSeen = asString(row.last_seen);
    const keyword = asString(row.keyword);

    // Platform scope: unchanged from before the keyword join existed.
    if (asString(row.scope) !== "keyword" || !keyword) {
      return build({
        clientId,
        signalType: "competitor_citation_gain",
        entityType: "platform",
        entityId: `${platform}:${competitor}`,
        severity,
        confidence: 0.75,
        evidence: {
          scope: "platform",
          platform,
          competitor_domain: competitor,
          occurrences,
          sample_queries: sampleQueries,
          last_seen: lastSeen,
        },
        groupKey: `platform:${platform}`,
      });
    }

    // Keyword scope. The same 5-position bar `keywordDropExtractor` applies, so
    // this signal cannot outlive the ranking drop it is paired with — a citation
    // loss on a keyword that only slipped 2 places is answer-engine news, not a
    // compound SERP failure, and belongs to the platform row above.
    const delta = asNumber(row.position_delta);
    if (delta === null || delta < 5) return null;

    const url = asString(row.url);
    const pageKey = normalizePageKey(url);

    return build({
      clientId,
      signalType: "competitor_citation_gain",
      entityType: "keyword",
      // Distinct from the platform scope's entityId on purpose: the fingerprint
      // is (client, signalType, entityId), and a collision would make the two
      // scopes suppress each other through the cooldown and go mutually blind.
      entityId: `${keyword}@${platform}:${competitor}`,
      severity,
      confidence: 0.75,
      evidence: {
        scope: "keyword",
        keyword,
        platform,
        competitor_domain: competitor,
        occurrences,
        position_delta: delta,
        url,
        page_path: pageKey,
        sample_queries: sampleQueries,
        last_seen: lastSeen,
      },
      // Mirrors `keywordDropExtractor` exactly — this is the whole point of the
      // scope. When the two disagree (a keyword ranking on different URLs per
      // device), the compound simply does not form and the plane falls back to
      // the two single-symptom diagnoses, which is the behavior that shipped.
      groupKey: pageKey ?? `keyword:${keyword}`,
    });
  },
};

/**
 * High-authority prospects discovered and never contacted.
 *
 * THE "NEVER CONTACTED" SET IS ('ready', 'needs_email') — NOT 'discovered'.
 * `link_prospects.status` DEFAULTS to 'discovered' in the schema, which makes
 * that the obvious filter, but `discoverProspects` always overwrites it on
 * insert: 'ready' when it found a contact email, 'needs_email' when it did not.
 * No row is ever left in the default state, so `status = 'discovered'` matched
 * nothing and this extractor never produced a signal.
 *
 * Both states are counted on purpose, because the severity ladder below draws
 * its distinction between them: 'ready' rows carry a contact_email and land in
 * `with_contact`, 'needs_email' rows do not. Narrowing the filter to 'ready'
 * alone would make `with_contact` equal `count` and collapse that ladder.
 *
 * Stated positively rather than as `status <> 'outreach_queued'`: if a new
 * post-contact state is added later, the positive form silently omits it,
 * whereas the negative form would count an already-contacted prospect and
 * invite duplicate outreach.
 */
export const prospectReadyExtractor: SignalExtractor = {
  signalType: "prospect_high_dr_ready",
  description: "Discovered link prospects above the authority bar, not yet contacted.",
  query: (clientId) => sql`
    SELECT count(*) AS prospect_count,
           max(domain_rating) AS best_domain_rating,
           round(avg(domain_rating)::numeric, 1) AS avg_domain_rating,
           count(*) FILTER (WHERE contact_email IS NOT NULL) AS with_contact
    FROM link_prospects
    WHERE client_id = ${clientId}::uuid
      AND status IN ('ready', 'needs_email')
      AND domain_rating >= 40
  `,
  mapRow: (row, clientId) => {
    const count = asNumber(row.prospect_count) ?? 0;
    const withContact = asNumber(row.with_contact) ?? 0;
    // Prospects nobody can reach are not an outreach opportunity.
    if (count < 3 || withContact < 1) return null;

    // Severity scales with the CONTACTABLE subset, not the raw count: a batch is
    // only an outreach opportunity to the extent someone can be written to, and
    // `count` alone would rate a list of 200 addressless domains above a list of
    // 25 reachable ones.
    //
    // The `high` rung is what makes `link_outreach_batch` reachable at all. Its
    // scoring weights (impact 5, effort 2, risk 3) put a `medium` signal at 18,
    // below the shipped INTELLIGENCE_MIN_OPPORTUNITY_SCORE of 20 — so while
    // `medium` was this extractor's ceiling, outreach could never be proposed,
    // and the outreach flag, the velocity governor and the route_safe promise
    // were all guarding a path no real signal could take.
    // `calibration.test.ts` pins every actionable type against the threshold
    // through its real extractor, so this cannot silently regress.
    // Not a ladder — two different measures. Contactable prospects outrank raw
    // volume, so they are tested first (typescript:S3358).
    let severity: SignalSeverity = "low";
    if (withContact >= 20) severity = "high";
    else if (count >= 20) severity = "medium";
    return build({
      clientId,
      signalType: "prospect_high_dr_ready",
      entityType: "client",
      entityId: "link_prospects",
      severity,
      confidence: 0.9,
      evidence: {
        prospect_count: count,
        contactable_count: withContact,
        best_domain_rating: asNumber(row.best_domain_rating),
        avg_domain_rating: asNumber(row.avg_domain_rating),
      },
      groupKey: "client:link_prospects",
    });
  },
};

/** Month-to-date token spend is approaching the client's monthly budget. */
export function llmBudgetExtractor(monthlyBudgetUsd: number): SignalExtractor {
  return {
    signalType: "llm_budget_pressure",
    description: "Month-to-date LLM spend approaching the configured monthly budget.",
    query: (clientId) => sql`
      SELECT COALESCE(sum(cost), 0)::numeric(12, 4) AS spend_usd,
             count(*) AS call_count
      FROM llm_usage
      WHERE client_id = ${clientId}::uuid
        AND timestamp >= date_trunc('month', now())
    `,
    mapRow: (row, clientId) => {
      const spend = asNumber(row.spend_usd);
      if (spend === null || monthlyBudgetUsd <= 0) return null;

      const utilization = spend / monthlyBudgetUsd;
      if (utilization < 0.8) return null;

      const severity: SignalSeverity = byThreshold<SignalSeverity>(
        utilization,
        [
          [1, "critical"],
          [0.9, "high"],
        ],
        "medium",
      );

      return build({
        clientId,
        signalType: "llm_budget_pressure",
        entityType: "client",
        entityId: "llm_budget",
        severity,
        confidence: 1,
        evidence: {
          spend_usd: spend,
          monthly_budget_usd: monthlyBudgetUsd,
          utilization: Math.round(utilization * 1000) / 1000,
          call_count: asNumber(row.call_count),
        },
        groupKey: "client:llm_budget",
      });
    },
  };
}

/** The same scheduled job failed more than once in 48 hours. */
export const jobFailureExtractor: SignalExtractor = {
  signalType: "job_failure_cluster",
  description: "Scheduled jobs that failed repeatedly in the last 48 hours.",
  query: (clientId) => sql`
    SELECT job_name,
           count(*) AS failure_count,
           max(started_at) AS last_failure_at
    FROM job_executions
    WHERE client_id = ${clientId}::uuid
      AND status IN ('failed', 'error')
      AND started_at >= now() - interval '48 hours'
    GROUP BY job_name
    HAVING count(*) >= 2
    ORDER BY count(*) DESC
    LIMIT 25
  `,
  mapRow: (row, clientId) => {
    const jobName = asString(row.job_name);
    const failures = asNumber(row.failure_count) ?? 0;
    if (!jobName || failures < 2) return null;

    const severity: SignalSeverity = byThreshold<SignalSeverity>(
      failures,
      [
        [5, "critical"],
        [3, "high"],
      ],
      "medium",
    );
    return build({
      clientId,
      signalType: "job_failure_cluster",
      entityType: "job",
      entityId: jobName,
      severity,
      confidence: 1,
      evidence: {
        job_name: jobName,
        failure_count: failures,
        last_failure_at: asString(row.last_failure_at),
        // Named explicitly: every downstream signal for this client is only as
        // fresh as the job that feeds it.
        impact: "Data feeding other signals for this client may be stale.",
      },
      groupKey: `job:${jobName}`,
    });
  },
};

/** All extractors that need no configuration. */
export const STATIC_EXTRACTORS: readonly SignalExtractor[] = [
  keywordDropExtractor,
  pageExperienceExtractor,
  lcpRegressionExtractor,
  citationRateExtractor,
  competitorCitationExtractor,
  prospectReadyExtractor,
  jobFailureExtractor,
];

export function allExtractors(monthlyBudgetUsd: number): SignalExtractor[] {
  return [...STATIC_EXTRACTORS, llmBudgetExtractor(monthlyBudgetUsd)];
}

/**
 * Run every extractor for one client.
 *
 * A failing extractor does not abort the cycle: partial signal coverage plus a
 * logged failure is strictly better than a run that produces nothing because one
 * view was slow. The `job_failure_cluster` extractor is what surfaces a
 * persistently broken one.
 */
export async function extractSignals(
  clientId: string,
  extractors: readonly SignalExtractor[],
): Promise<{ signals: SignalCandidate[]; failures: { signalType: SignalType; error: string }[] }> {
  const db = getDb();
  const signals: SignalCandidate[] = [];
  const failures: { signalType: SignalType; error: string }[] = [];

  for (const extractor of extractors) {
    try {
      const result = await db.execute(extractor.query(clientId));
      const rows = (result as unknown as { rows: Row[] }).rows ?? [];
      for (const row of rows) {
        const signal = extractor.mapRow(row, clientId);
        if (signal) signals.push(signal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ signalType: extractor.signalType, error: message });
      logger.error(
        { clientId, signalType: extractor.signalType, err: message },
        "Signal extractor failed",
      );
    }
  }

  return { signals, failures };
}

/**
 * Drop signals whose fingerprint was already observed inside the cooldown.
 *
 * Without this the same unchanged problem regenerates the same opportunity every
 * cycle, and the approval queue fills with duplicates until the operator stops
 * reading it. Pure, so the window logic is testable without a database.
 */
export function applySuppression(
  signals: readonly SignalCandidate[],
  recentFingerprints: ReadonlySet<string>,
): { kept: SignalCandidate[]; suppressed: SignalCandidate[] } {
  const kept: SignalCandidate[] = [];
  const suppressed: SignalCandidate[] = [];
  for (const signal of signals) {
    // A critical finding is never suppressed: "we already told you" is not a
    // reason to stop reporting something that is still critical.
    if (signal.severity !== "critical" && recentFingerprints.has(signal.fingerprint)) {
      suppressed.push(signal);
    } else {
      kept.push(signal);
    }
  }
  return { kept, suppressed };
}
