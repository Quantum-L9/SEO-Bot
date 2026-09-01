/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Named Intelligence Queries
 *
 * Every SQL statement the intelligence module runs lives here, as a named,
 * parameterized function. There is no generic `runQuery(sql)` anywhere in the
 * module and there must never be one.
 *
 * WHY NAMED QUERIES RATHER THAN A QUERY BUILDER OR AN LLM.
 *
 * Not an LLM: a model that can write SQL can read any table. The whole safety
 * argument for this module is that the LLM sees a sanitized evidence pack and
 * nothing else. Giving it SQL would make every other guard decorative.
 *
 * Not the query builder: these are INSERT..SELECT..ON CONFLICT statements. The
 * upsert happens inside the database in one round trip, which makes idempotency
 * atomic rather than a check-then-write race under concurrent fan-out. Reading
 * rows into Node to decide what to insert reintroduces exactly that race.
 *
 * EVERY QUERY IS CLIENT-SCOPED, AND THE SCOPE IS A BOUND PARAMETER.
 * `${clientId}` in a Drizzle `sql` template is a bind placeholder, never string
 * interpolation, so a client id cannot alter the statement. `assertClientId`
 * runs first regardless, because an undefined bound into a `=` comparison
 * silently matches nothing (or, in a different position, everything).
 */

import { type SQL, sql } from "drizzle-orm";

/** Signal families this module extracts. */
export type SignalType =
  | "keyword_drop"
  | "bad_lcp_high_exit"
  | "citation_loss"
  | "prospect_ready"
  | "llm_budget_pressure"
  | "job_failure_cluster";

/**
 * `link_prospects.status` meaning "has a contact email, not yet contacted".
 *
 * The column DEFAULTS to "discovered", but `discoverProspects` always
 * overwrites it on insert with "ready" or "needs_email", so no row is ever left
 * in the default state — filtering on "discovered" matches nothing.
 * `processOutreach` consumes "ready", which is exactly this signal's meaning.
 *
 * Note that `ProspectStatus` in src/types/index.ts declares a third, unrelated
 * vocabulary that no code writes. The runtime values are authoritative.
 */
export const PROSPECT_READY_STATUS = "ready";

export const THRESHOLDS = {
  /** Positions lost before a ranking move counts as a drop. */
  keywordDropMinDelta: 5,
  /** Lookback window for ranking observations. */
  keywordLookbackDays: 7,
  /** LCP (seconds) at or above which Core Web Vitals is "poor". */
  lcpPoorSeconds: 4.0,
  /** Exit rate (0..1) at or above which a page is a dead end. */
  highExitRate: 0.7,
  /** Minimum domain rating for a link prospect to be worth outreach. */
  prospectMinDomainRating: 30,
  /** Fraction of the daily LLM cap that counts as budget pressure. */
  budgetPressureRatio: 0.8,
  /** Failures of one job in the window before it is a cluster. */
  jobFailureClusterCount: 3,
  /** Window for job-failure clustering. */
  jobFailureWindowHours: 24,
} as const;

/**
 * Guard against an undefined/blank clientId reaching a query.
 *
 * A bound `undefined` does not throw in Drizzle — it produces a comparison that
 * silently changes the result set. For multi-tenant tables that is a
 * cross-tenant read, so this is a hard failure rather than a warning.
 */
export function assertClientId(clientId: string | undefined | null): asserts clientId is string {
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error(
      "intelligence: clientId is required for every signal query (refusing to run an unscoped, cross-tenant read)",
    );
  }
}

/**
 * Shared tail of every extractor.
 *
 * `status` is deliberately absent from the update set: an operator who
 * suppressed a signal must not have it reopened by the next extraction run.
 * `first_seen_at` is likewise preserved — it records when the problem started,
 * which is exactly what a re-observation must not reset.
 */
const UPSERT_TAIL = sql`
  ON CONFLICT (client_id, fingerprint) DO UPDATE SET
    run_id = EXCLUDED.run_id,
    severity = EXCLUDED.severity,
    confidence = EXCLUDED.confidence,
    evidence = EXCLUDED.evidence,
    observed_at = EXCLUDED.observed_at
`;

const INSERT_HEAD = sql`
  INSERT INTO intelligence_signals (
    run_id, client_id, entity_type, entity_key, signal_type,
    severity, confidence, evidence, fingerprint, observed_at
  )
`;

/**
 * keyword_drop - a tracked keyword lost ground.
 *
 * `position` and `previous_position` are nullable (a keyword can fall out of
 * the tracked range entirely), and both are checked NOT NULL before the
 * subtraction: a null is "unknown", not "position 0", and treating it as a
 * number would manufacture a hundred-place move.
 *
 * Severity keys off whether the drop CROSSED off page one, not merely where it
 * landed. A keyword already at #40 sliding to #48 never had page-one traffic to
 * lose; scoring that the same as #3 -> #11 would misrank the whole queue.
 */
export function keywordDropsQuery(clientId: string, runId: string): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT
      ${runId}::uuid,
      sr.client_id,
      'keyword',
      sr.keyword,
      'keyword_drop',
      CASE
        WHEN sr.position - sr.previous_position >= 10 AND sr.previous_position <= 10 AND sr.position > 10 THEN 'critical'
        WHEN sr.previous_position <= 10 AND sr.position > 10 THEN 'high'
        WHEN sr.position - sr.previous_position >= 10 THEN 'high'
        WHEN sr.position - sr.previous_position >= 5 THEN 'medium'
        ELSE 'low'
      END,
      LEAST(1.0, (sr.position - sr.previous_position)::real / 20.0),
      jsonb_build_object(
        'keyword', sr.keyword,
        'url', sr.url,
        'previous_position', sr.previous_position,
        'current_position', sr.position,
        'position_delta', sr.position - sr.previous_position,
        'checked_at', sr.checked_at
      ),
      md5(sr.client_id::text || ':keyword_drop:' || sr.keyword),
      now()
    FROM serp_rankings sr
    -- One row per keyword: the most recent observation wins. Without this the
    -- same keyword's history would collide on the fingerprint and the upsert
    -- would apply them in arbitrary order.
    INNER JOIN (
      SELECT keyword, MAX(checked_at) AS latest
      FROM serp_rankings
      WHERE client_id = ${clientId}::uuid
      GROUP BY keyword
    ) newest ON newest.keyword = sr.keyword AND newest.latest = sr.checked_at
    WHERE sr.client_id = ${clientId}::uuid
      AND sr.checked_at >= now() - (${THRESHOLDS.keywordLookbackDays} || ' days')::interval
      AND sr.position IS NOT NULL
      AND sr.previous_position IS NOT NULL
      AND sr.position - sr.previous_position >= ${THRESHOLDS.keywordDropMinDelta}
    ${UPSERT_TAIL}
  `;
}

/**
 * bad_lcp_high_exit - a slow page that visitors also abandon.
 *
 * The join is the point: a slow page nobody visits is not urgent, and a
 * high-exit page that loads fast is a content problem, not a performance one.
 * Only the intersection is actionable.
 *
 * web_vitals stores a full URL and page_engagement stores a path, so the URL is
 * reduced to a path before comparison. Without that normalization the join
 * matches nothing and this signal type never fires at all.
 *
 * Confidence is capped below the other families: current vitals collection is
 * largely domain-level while engagement is per-page, so the pairing is a
 * reasonable inference rather than a direct measurement of the same page.
 */
export function pageExperienceRisksQuery(clientId: string, runId: string): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT DISTINCT ON (page_path)
      ${runId}::uuid,
      wv.client_id,
      'page',
      page_path,
      'bad_lcp_high_exit',
      CASE WHEN pe.exit_rate >= 0.85 OR wv.lcp >= 6 THEN 'high' ELSE 'medium' END,
      0.6,
      jsonb_build_object(
        'path', page_path,
        'url', wv.url,
        'lcp', wv.lcp,
        'exit_rate', pe.exit_rate,
        'avg_time_on_page', pe.avg_time_on_page,
        'unique_visitors', pe.unique_visitors,
        'device', wv.device
      ),
      md5(wv.client_id::text || ':bad_lcp_high_exit:' || page_path),
      now()
    FROM web_vitals wv
    CROSS JOIN LATERAL (
      -- Reduce the stored URL to a comparable path: strip scheme+host, then the
      -- trailing slash, so "/pricing" and "/pricing/" are one page.
      SELECT NULLIF(
        regexp_replace(
          regexp_replace(wv.url, '^https?://[^/]+', ''),
          '/$', ''
        ), ''
      ) AS page_path
    ) norm
    INNER JOIN page_engagement pe
      ON pe.client_id = wv.client_id
     AND NULLIF(regexp_replace(pe.page_path, '/$', ''), '') = norm.page_path
    WHERE wv.client_id = ${clientId}::uuid
      AND norm.page_path IS NOT NULL
      AND wv.lcp IS NOT NULL
      AND wv.lcp >= ${THRESHOLDS.lcpPoorSeconds}
      AND pe.exit_rate IS NOT NULL
      AND pe.exit_rate >= ${THRESHOLDS.highExitRate}
    ORDER BY page_path, wv.measured_at DESC
    ${UPSERT_TAIL}
  `;
}

/**
 * citation_loss - the client was cited for a query and no longer is.
 *
 * Requires a PRIOR citation. "We have never been cited on this platform" and
 * "we were cited and lost it" are different facts and only the second is a
 * signal; a platform whose rows are all `cited = false` has nothing to lose.
 * That check also skips the AEO module's placeholder platforms, which never
 * produce a positive citation.
 */
export function citationLossQuery(clientId: string, runId: string): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT DISTINCT ON (latest.platform, latest.query)
      ${runId}::uuid,
      latest.client_id,
      'query',
      latest.platform || '::' || latest.query,
      'citation_loss',
      CASE WHEN latest.competitor_cited IS NOT NULL THEN 'high' ELSE 'medium' END,
      CASE WHEN latest.competitor_cited IS NOT NULL THEN 0.8 ELSE 0.5 END,
      jsonb_build_object(
        'platform', latest.platform,
        'query', latest.query,
        'competitor_cited', latest.competitor_cited,
        'checked_at', latest.checked_at
      ),
      md5(latest.client_id::text || ':citation_loss:' || latest.platform || '::' || latest.query),
      now()
    FROM (
      SELECT DISTINCT ON (platform, query) *
      FROM aeo_citations
      WHERE client_id = ${clientId}::uuid
        AND platform IS NOT NULL
        AND query IS NOT NULL
      ORDER BY platform, query, checked_at DESC
    ) latest
    WHERE latest.cited = false
      AND EXISTS (
        SELECT 1 FROM aeo_citations prior
        WHERE prior.client_id = latest.client_id
          AND prior.platform = latest.platform
          AND prior.query = latest.query
          AND prior.cited = true
          AND prior.checked_at < latest.checked_at
      )
    ${UPSERT_TAIL}
  `;
}

/**
 * prospect_ready - a link prospect worth contacting.
 *
 * The only signal that can lead to an irreversible action, so its preconditions
 * are the strictest: status "ready", a contact email present, and domain rating
 * above the floor. The contact email is deliberately NOT copied into evidence —
 * evidence reaches the LLM planner and the operator API, and a prospect's email
 * is PII with no bearing on whether to act.
 */
export function prospectReadinessQuery(clientId: string, runId: string): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT
      ${runId}::uuid,
      lp.client_id,
      'prospect',
      lp.target_url,
      'prospect_ready',
      CASE WHEN lp.domain_rating >= 60 THEN 'high' ELSE 'medium' END,
      LEAST(1.0, lp.domain_rating::real / 100.0),
      jsonb_build_object(
        'target_url', lp.target_url,
        'domain_rating', lp.domain_rating,
        'relevance_score', lp.relevance_score,
        'tactic', lp.tactic,
        'has_contact_email', true
      ),
      md5(lp.client_id::text || ':prospect_ready:' || lp.target_url),
      now()
    FROM link_prospects lp
    WHERE lp.client_id = ${clientId}::uuid
      AND lp.status = ${PROSPECT_READY_STATUS}
      AND lp.contact_email IS NOT NULL
      AND lp.domain_rating IS NOT NULL
      AND lp.domain_rating >= ${THRESHOLDS.prospectMinDomainRating}
    ${UPSERT_TAIL}
  `;
}

/**
 * llm_budget_pressure - this client is close to its daily LLM spend cap.
 *
 * Reads llm_usage, which is what LlmService actually writes, rather than the
 * /api/token-budget endpoint's estimate derived from action_outcomes. Those two
 * disagree, and the spend that matters for a planning decision is the recorded
 * one.
 *
 * Emitted as a signal rather than checked inline so budget pressure is visible
 * in the same ledger as everything else the loop noticed, and so the operator
 * API surfaces it without a special case.
 */
export function budgetPressureQuery(clientId: string, runId: string, dailyCap: number): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT
      ${runId}::uuid,
      spend.client_id,
      'client',
      'daily_llm_spend',
      'llm_budget_pressure',
      CASE WHEN spend.total >= ${dailyCap} THEN 'critical' ELSE 'high' END,
      1.0,
      jsonb_build_object(
        'spend_today', round(spend.total::numeric, 4),
        'daily_cap', ${dailyCap},
        'ratio', round((spend.total / NULLIF(${dailyCap}, 0))::numeric, 4)
      ),
      md5(spend.client_id::text || ':llm_budget_pressure:daily_llm_spend'),
      now()
    FROM (
      SELECT client_id, COALESCE(SUM(cost), 0)::float8 AS total
      FROM llm_usage
      WHERE client_id = ${clientId}::uuid
        AND timestamp >= date_trunc('day', now())
      GROUP BY client_id
    ) spend
    WHERE ${dailyCap} > 0
      AND spend.total >= ${dailyCap} * ${THRESHOLDS.budgetPressureRatio}
    ${UPSERT_TAIL}
  `;
}

/**
 * job_failure_cluster - one job failing repeatedly for this client.
 *
 * A single failure is noise (a timeout, a provider blip); a cluster is a broken
 * integration. This signal routes to operator escalation only — the loop cannot
 * fix its own plumbing, and an autonomous retry storm against a failing
 * provider is worse than telling a human.
 */
export function failedJobsQuery(clientId: string, runId: string): SQL {
  assertClientId(clientId);
  return sql`
    ${INSERT_HEAD}
    SELECT
      ${runId}::uuid,
      ${clientId}::uuid,
      'job',
      failures.job_name,
      'job_failure_cluster',
      CASE WHEN failures.failure_count >= 10 THEN 'critical' ELSE 'high' END,
      1.0,
      jsonb_build_object(
        'job_name', failures.job_name,
        'failure_count', failures.failure_count,
        'window_hours', ${THRESHOLDS.jobFailureWindowHours},
        'last_error', failures.last_error
      ),
      md5(${clientId}::text || ':job_failure_cluster:' || failures.job_name),
      now()
    FROM (
      SELECT
        job_name,
        COUNT(*)::int AS failure_count,
        (ARRAY_AGG(error ORDER BY started_at DESC))[1] AS last_error
      FROM job_executions
      WHERE client_id = ${clientId}::uuid
        AND status = 'failed'
        AND started_at >= now() - (${THRESHOLDS.jobFailureWindowHours} || ' hours')::interval
      GROUP BY job_name
      HAVING COUNT(*) >= ${THRESHOLDS.jobFailureClusterCount}
    ) failures
    ${UPSERT_TAIL}
  `;
}

/**
 * Infer a target URL for an opportunity when client config does not supply one.
 *
 * Registration maps target keywords as keyword/priority pairs without a page
 * URL, so the planner cannot assume one exists. These four observed sources are
 * tried in order of directness; the query returns at most one row.
 */
export function inferTargetUrlQuery(clientId: string, keyword: string | null): SQL {
  assertClientId(clientId);
  return sql`
    SELECT url FROM (
      SELECT sr.url AS url, 1 AS rank, sr.checked_at AS seen
      FROM serp_rankings sr
      WHERE sr.client_id = ${clientId}::uuid
        AND sr.url IS NOT NULL
        AND (${keyword}::text IS NULL OR sr.keyword = ${keyword}::text)
      UNION ALL
      SELECT ga.client_url, 2, ga.generated_at
      FROM gap_analyses ga
      WHERE ga.client_id = ${clientId}::uuid
        AND ga.client_url IS NOT NULL
        AND (${keyword}::text IS NULL OR ga.keyword = ${keyword}::text)
      UNION ALL
      SELECT fo.page_url, 3, fo.last_updated
      FROM faq_optimizations fo
      WHERE fo.client_id = ${clientId}::uuid AND fo.page_url IS NOT NULL
      UNION ALL
      SELECT pe.page_path, 4, pe.computed_at
      FROM page_engagement pe
      WHERE pe.client_id = ${clientId}::uuid AND pe.page_path IS NOT NULL
    ) candidates
    ORDER BY rank ASC, seen DESC
    LIMIT 1
  `;
}
