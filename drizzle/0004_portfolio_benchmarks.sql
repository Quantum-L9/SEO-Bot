-- ═══════════════════════════════════════════════════════════════════════════════
-- SEO-Bot Portfolio Benchmarking Plane (ADR-0015, contract C1)
--
-- "Is a 40% citation rate good for a legal client in NC?" is the one question
-- the reporting plane could not answer: every existing view is per-tenant, so a
-- cross-client comparison meant handing someone a connection string.
--
-- The answer is a COHORT statistic — industry × geography × month — and a cohort
-- statistic is only safe if the cohort is large enough to hide the individuals
-- in it. With two clients in a cohort, each derives the other's numbers exactly
-- from the aggregate and its own; with three or four, closely. That is why this
-- view did not already exist, and why the k-anonymity floor below is load-
-- bearing rather than decorative.
--
-- The floor is applied TWICE, and the second application is the one that is easy
-- to miss:
--
--   1. Row level  — HAVING count(DISTINCT client_id) >= 5 drops a whole cohort
--      that is too small.
--   2. METRIC level — each percentile is guarded by its own non-null contributor
--      count. A cohort can hold 5 clients while only 2 of them have Core Web
--      Vitals data; publishing an LCP median over those 2 under a 5-client
--      cohort label would be a two-client disclosure wearing a five-client
--      label. Every metric therefore carries its own count and its own guard.
--
-- No client id, name, or domain appears in the published view — only the cohort
-- dimensions and the distribution.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Per-client, per-month inputs ─────────────────────────────────────────────
-- Deliberately NOT registered in the reporting view registry: this is the
-- building block the benchmark aggregates over, and it is per-client by
-- construction. Unregistered means unreachable through the query gateway.
--
-- Cohort dimensions are normalized here — lower-cased, blank-collapsed, and
-- 'unknown' where absent — so that "Legal" and "legal" are one cohort rather
-- than two half-sized ones, and so the UNIQUE index the materialized view needs
-- has no NULLs to make ambiguous.
CREATE OR REPLACE VIEW "reporting"."client_period_metrics" AS
WITH positions AS (
  SELECT
    client_id,
    date_trunc('month', checked_at)::date AS period,
    avg(position)::numeric AS avg_position
  FROM "public"."serp_rankings"
  WHERE position IS NOT NULL
  GROUP BY 1, 2
),
vitals AS (
  SELECT
    client_id,
    date_trunc('month', measured_at)::date AS period,
    avg(lcp)::numeric AS avg_lcp
  FROM "public"."web_vitals"
  WHERE lcp IS NOT NULL
  GROUP BY 1, 2
),
engagement AS (
  SELECT
    client_id,
    date_trunc('month', computed_at)::date AS period,
    avg(exit_rate)::numeric AS avg_exit_rate
  FROM "public"."page_engagement"
  WHERE exit_rate IS NOT NULL
  GROUP BY 1, 2
),
citations AS (
  SELECT
    client_id,
    date_trunc('month', checked_at)::date AS period,
    (100.0 * count(*) FILTER (WHERE cited) / NULLIF(count(*), 0))::numeric AS citation_rate_pct
  FROM "public"."aeo_citations"
  GROUP BY 1, 2
),
-- A client contributes to a cohort if it has ANY of the four metrics that month.
-- Intersecting instead would silently shrink every cohort to the clients that
-- happen to have all four, which is how a k-anonymity floor gets satisfied on
-- paper and violated in fact.
cohort_keys AS (
  SELECT client_id, period FROM positions
  UNION
  SELECT client_id, period FROM vitals
  UNION
  SELECT client_id, period FROM engagement
  UNION
  SELECT client_id, period FROM citations
)
SELECT
  k.client_id,
  k.period,
  COALESCE(NULLIF(btrim(lower(c.industry)), ''), 'unknown') AS industry,
  COALESCE(NULLIF(btrim(lower(c.country)), ''), 'unknown') AS country,
  COALESCE(NULLIF(btrim(lower(c.state)), ''), 'unknown') AS state,
  p.avg_position,
  v.avg_lcp,
  e.avg_exit_rate,
  ct.citation_rate_pct
FROM cohort_keys k
JOIN "reporting"."clients_safe" c USING (client_id)
LEFT JOIN positions p ON p.client_id = k.client_id AND p.period = k.period
LEFT JOIN vitals v ON v.client_id = k.client_id AND v.period = k.period
LEFT JOIN engagement e ON e.client_id = k.client_id AND e.period = k.period
LEFT JOIN citations ct ON ct.client_id = k.client_id AND ct.period = k.period;
--> statement-breakpoint

-- ─── Cohort benchmarks ────────────────────────────────────────────────────────
-- Every `>= 5` below is the k-anonymity floor. Lowering any one of them is a
-- privacy change and must be a migration, which is why the number is a literal
-- here rather than a function an operator could redefine at runtime.
-- `plane-contract.test.ts` reads these literals back and checks them against
-- BENCHMARK_K_ANONYMITY_FLOOR in src/reporting/views.ts.
CREATE OR REPLACE VIEW "reporting"."portfolio_benchmarks" AS
SELECT
  industry,
  country,
  state,
  period,
  count(DISTINCT client_id)::int AS cohort_size,

  -- SERP position (lower is better)
  CASE WHEN count(avg_position) >= 5 THEN count(avg_position)::int END AS position_clients,
  CASE WHEN count(avg_position) >= 5
    THEN round(percentile_cont(0.25) WITHIN GROUP (ORDER BY avg_position)::numeric, 2) END AS position_p25,
  CASE WHEN count(avg_position) >= 5
    THEN round(percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_position)::numeric, 2) END AS position_p50,
  CASE WHEN count(avg_position) >= 5
    THEN round(percentile_cont(0.75) WITHIN GROUP (ORDER BY avg_position)::numeric, 2) END AS position_p75,

  -- Largest Contentful Paint, milliseconds (lower is better)
  CASE WHEN count(avg_lcp) >= 5 THEN count(avg_lcp)::int END AS lcp_clients,
  CASE WHEN count(avg_lcp) >= 5
    THEN round(percentile_cont(0.25) WITHIN GROUP (ORDER BY avg_lcp)::numeric, 2) END AS lcp_p25,
  CASE WHEN count(avg_lcp) >= 5
    THEN round(percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_lcp)::numeric, 2) END AS lcp_p50,
  CASE WHEN count(avg_lcp) >= 5
    THEN round(percentile_cont(0.75) WITHIN GROUP (ORDER BY avg_lcp)::numeric, 2) END AS lcp_p75,

  -- Exit rate, 0..1 (lower is better)
  CASE WHEN count(avg_exit_rate) >= 5 THEN count(avg_exit_rate)::int END AS exit_rate_clients,
  CASE WHEN count(avg_exit_rate) >= 5
    THEN round(percentile_cont(0.25) WITHIN GROUP (ORDER BY avg_exit_rate)::numeric, 4) END AS exit_rate_p25,
  CASE WHEN count(avg_exit_rate) >= 5
    THEN round(percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_exit_rate)::numeric, 4) END AS exit_rate_p50,
  CASE WHEN count(avg_exit_rate) >= 5
    THEN round(percentile_cont(0.75) WITHIN GROUP (ORDER BY avg_exit_rate)::numeric, 4) END AS exit_rate_p75,

  -- Answer-engine citation rate, percent (higher is better)
  CASE WHEN count(citation_rate_pct) >= 5 THEN count(citation_rate_pct)::int END AS citation_rate_clients,
  CASE WHEN count(citation_rate_pct) >= 5
    THEN round(percentile_cont(0.25) WITHIN GROUP (ORDER BY citation_rate_pct)::numeric, 2) END AS citation_rate_p25,
  CASE WHEN count(citation_rate_pct) >= 5
    THEN round(percentile_cont(0.50) WITHIN GROUP (ORDER BY citation_rate_pct)::numeric, 2) END AS citation_rate_p50,
  CASE WHEN count(citation_rate_pct) >= 5
    THEN round(percentile_cont(0.75) WITHIN GROUP (ORDER BY citation_rate_pct)::numeric, 2) END AS citation_rate_p75

FROM "reporting"."client_period_metrics"
GROUP BY industry, country, state, period
HAVING count(DISTINCT client_id) >= 5;
--> statement-breakpoint

-- ─── Cohort coverage ──────────────────────────────────────────────────────────
-- Why a benchmark came back empty. Without this an operator asking a legitimate
-- question gets an empty result and no way to tell "the floor suppressed it"
-- from "the pipeline is broken" — and the first explanation is the common one on
-- a small portfolio.
--
-- Publishing `client_count` for a SUPPRESSED cohort would undo the floor, so it
-- is not published: the row says a cohort exists and is below the floor, never
-- how far below.
CREATE OR REPLACE VIEW "reporting"."portfolio_cohort_coverage" AS
SELECT
  industry,
  country,
  state,
  period,
  (count(DISTINCT client_id) >= 5) AS meets_anonymity_floor,
  CASE WHEN count(DISTINCT client_id) >= 5 THEN count(DISTINCT client_id)::int END AS cohort_size
FROM "reporting"."client_period_metrics"
GROUP BY industry, country, state, period;
--> statement-breakpoint

-- ─── Materialization ──────────────────────────────────────────────────────────
-- Percentiles over four LEFT JOINed monthly aggregates is not a per-request
-- query. Refreshed by the scheduler like the other portfolio views; the UNIQUE
-- index is what makes REFRESH ... CONCURRENTLY available.
--
-- No column in the index is nullable: the cohort dimensions are COALESCEd to
-- 'unknown' upstream, because NULLs compare as distinct in a btree and would
-- leave CONCURRENTLY unable to identify a row it needs to diff.
CREATE MATERIALIZED VIEW IF NOT EXISTS "reporting"."mv_portfolio_benchmarks" AS
SELECT * FROM "reporting"."portfolio_benchmarks";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mv_portfolio_benchmarks_unique"
ON "reporting"."mv_portfolio_benchmarks" (industry, country, state, period);
--> statement-breakpoint

CREATE MATERIALIZED VIEW IF NOT EXISTS "reporting"."mv_portfolio_cohort_coverage" AS
SELECT * FROM "reporting"."portfolio_cohort_coverage";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mv_portfolio_cohort_coverage_unique"
ON "reporting"."mv_portfolio_cohort_coverage" (industry, country, state, period);
--> statement-breakpoint

-- ─── Supporting indexes ───────────────────────────────────────────────────────
-- The month-bucketed aggregates above scan by (client_id, time). serp_rankings,
-- web_vitals and page_engagement already carry a latest-state index from
-- migration 0002; aeo_citations is indexed by month/platform but not by the
-- plain (client_id, checked_at) this rollup walks.
CREATE INDEX IF NOT EXISTS "idx_aeo_citations_client_checked"
ON "public"."aeo_citations" ("client_id", "checked_at");
