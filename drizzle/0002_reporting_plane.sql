-- ═══════════════════════════════════════════════════════════════════════════════
-- SEO-Bot Reporting SQL Plane (ADR-0015)
--
-- The governed read plane between operational Postgres and humans/agents.
-- Operational tables in `public` stay write-owned by the bot (Drizzle + BullMQ).
-- Everything in `reporting` is a read contract: no secrets, bounded joins,
-- stable semantics.
--
-- Roles and grants are NOT created here. A migration runs as the application
-- role and must not embed role passwords; provisioning lives in
-- `scripts/reporting/provision-roles.sql`, run by an operator AFTER this
-- migration (the grants target the objects created below).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS "reporting";
--> statement-breakpoint

-- ─── Normalized page key ──────────────────────────────────────────────────────
-- web_vitals stores a full URL; page_engagement stores a path. Joining the two
-- without normalization is brittle, so derive the path deterministically.
CREATE OR REPLACE FUNCTION "reporting"."path_from_url"(input_url text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT COALESCE(
    NULLIF(regexp_replace(regexp_replace(input_url, '^https?://[^/]+', ''), '[?#].*$', ''), ''),
    '/'
  );
$$;
--> statement-breakpoint

-- ─── Client dimensions ────────────────────────────────────────────────────────
-- NEVER expose posthog_api_key / posthog_project_id / config. The operator view
-- carries names and domains; the agent view carries neither.
CREATE OR REPLACE VIEW "reporting"."clients_safe"
WITH (security_barrier = true) AS
SELECT
  c.id AS client_id,
  c.name,
  c.domain,
  c.industry,
  c.city,
  c.state,
  c.country,
  c.active,
  c.created_at,
  c.updated_at
FROM "public"."clients" c
WHERE c.active = true;
--> statement-breakpoint

CREATE OR REPLACE VIEW "reporting"."clients_agent"
WITH (security_barrier = true) AS
SELECT
  c.id AS client_id,
  encode(digest(c.id::text, 'sha256'), 'hex') AS client_ref,
  c.industry,
  c.state,
  c.country,
  c.active,
  c.created_at
FROM "public"."clients" c
WHERE c.active = true;
--> statement-breakpoint

-- ─── Latest SERP state ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."latest_serp_rankings" AS
WITH ranked AS (
  SELECT
    sr.*,
    row_number() OVER (
      PARTITION BY sr.client_id, sr.keyword, COALESCE(sr.device, 'desktop')
      ORDER BY sr.checked_at DESC
    ) AS rn
  FROM "public"."serp_rankings" sr
)
SELECT
  r.client_id,
  c.name AS client_name,
  c.domain,
  r.keyword,
  COALESCE(r.device, 'desktop') AS device,
  r.position,
  r.previous_position,
  (r.position - r.previous_position) AS position_delta,
  CASE
    WHEN r.position IS NULL OR r.previous_position IS NULL THEN 'unknown'
    WHEN r.position < r.previous_position THEN 'improved'
    WHEN r.position > r.previous_position THEN 'declined'
    ELSE 'flat'
  END AS movement,
  r.url,
  r.serp_features,
  r.checked_at
FROM ranked r
JOIN "reporting"."clients_safe" c USING (client_id)
WHERE r.rn = 1;
--> statement-breakpoint

CREATE OR REPLACE VIEW "reporting"."keyword_drops_7d" AS
SELECT
  client_id,
  client_name,
  domain,
  keyword,
  device,
  previous_position,
  position AS current_position,
  position_delta,
  url,
  checked_at
FROM "reporting"."latest_serp_rankings"
WHERE position IS NOT NULL
  AND previous_position IS NOT NULL
  AND position_delta >= 5
  AND checked_at >= now() - interval '7 days';
--> statement-breakpoint

CREATE OR REPLACE VIEW "reporting"."weekly_keyword_movements" AS
WITH weekly AS (
  SELECT
    sr.client_id,
    sr.keyword,
    COALESCE(sr.device, 'desktop') AS device,
    date_trunc('week', sr.checked_at)::date AS week_start,
    sr.position,
    row_number() OVER (
      PARTITION BY sr.client_id, sr.keyword, COALESCE(sr.device, 'desktop'),
                   date_trunc('week', sr.checked_at)
      ORDER BY sr.checked_at ASC
    ) AS rn_first,
    row_number() OVER (
      PARTITION BY sr.client_id, sr.keyword, COALESCE(sr.device, 'desktop'),
                   date_trunc('week', sr.checked_at)
      ORDER BY sr.checked_at DESC
    ) AS rn_last
  FROM "public"."serp_rankings" sr
  WHERE sr.position IS NOT NULL
)
SELECT
  w.client_id,
  c.name AS client_name,
  c.domain,
  w.keyword,
  md5(w.keyword) AS keyword_hash,
  w.device,
  w.week_start,
  count(*) AS samples,
  min(w.position) AS best_position,
  max(w.position) AS worst_position,
  round(avg(w.position)::numeric, 2) AS avg_position,
  max(w.position) FILTER (WHERE w.rn_first = 1) AS week_open_position,
  max(w.position) FILTER (WHERE w.rn_last = 1) AS week_close_position,
  (
    max(w.position) FILTER (WHERE w.rn_last = 1)
    - max(w.position) FILTER (WHERE w.rn_first = 1)
  ) AS week_delta
FROM weekly w
JOIN "reporting"."clients_safe" c USING (client_id)
GROUP BY w.client_id, c.name, c.domain, w.keyword, w.device, w.week_start;
--> statement-breakpoint

-- ─── Page experience (vitals × engagement) ────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."page_experience_risks" AS
WITH latest_vitals AS (
  SELECT *
  FROM (
    SELECT
      wv.client_id,
      "reporting"."path_from_url"(wv.url) AS page_path,
      COALESCE(wv.device, 'mobile') AS device,
      wv.source,
      wv.lcp,
      wv.inp,
      wv.cls,
      wv.rating,
      wv.measured_at,
      row_number() OVER (
        PARTITION BY wv.client_id, "reporting"."path_from_url"(wv.url), COALESCE(wv.device, 'mobile')
        ORDER BY wv.measured_at DESC
      ) AS rn
    FROM "public"."web_vitals" wv
  ) x
  WHERE x.rn = 1
),
latest_engagement AS (
  SELECT *
  FROM (
    SELECT
      pe.client_id,
      pe.page_path,
      pe.period,
      pe.exit_rate,
      pe.bounce_rate,
      pe.avg_time_on_page,
      pe.avg_scroll_depth,
      pe.unique_visitors,
      pe.total_pageviews,
      pe.computed_at,
      row_number() OVER (
        PARTITION BY pe.client_id, pe.page_path, pe.period
        ORDER BY pe.computed_at DESC
      ) AS rn
    FROM "public"."page_engagement" pe
  ) x
  WHERE x.rn = 1
)
SELECT
  c.client_id,
  c.name AS client_name,
  c.domain,
  e.page_path,
  e.period,
  e.exit_rate,
  e.bounce_rate,
  e.avg_time_on_page,
  e.avg_scroll_depth,
  e.unique_visitors,
  e.total_pageviews,
  v.device,
  v.source,
  v.lcp,
  v.inp,
  v.cls,
  v.rating,
  v.measured_at,
  e.computed_at,
  CASE
    WHEN e.exit_rate >= 0.70 AND v.lcp >= 2500 THEN 'critical'
    WHEN e.exit_rate >= 0.50 AND v.lcp >= 2500 THEN 'high'
    WHEN v.lcp >= 2500 OR e.exit_rate >= 0.50 THEN 'medium'
    ELSE 'low'
  END AS risk_level
FROM latest_engagement e
JOIN latest_vitals v
  ON v.client_id = e.client_id
 AND v.page_path = e.page_path
JOIN "reporting"."clients_safe" c
  ON c.client_id = e.client_id;
--> statement-breakpoint

-- ─── Answer-engine citation rate ──────────────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."aeo_citation_rate_monthly" AS
SELECT
  ac.client_id,
  c.name AS client_name,
  c.domain,
  date_trunc('month', ac.checked_at)::date AS month,
  ac.platform,
  count(*) AS queries_checked,
  count(*) FILTER (WHERE ac.cited) AS cited_count,
  round(100.0 * count(*) FILTER (WHERE ac.cited) / NULLIF(count(*), 0), 2) AS citation_rate_pct,
  count(*) FILTER (WHERE ac.competitor_cited IS NOT NULL) AS competitor_cited_count
FROM "public"."aeo_citations" ac
JOIN "reporting"."clients_safe" c USING (client_id)
GROUP BY ac.client_id, c.name, c.domain, date_trunc('month', ac.checked_at), ac.platform;
--> statement-breakpoint

-- ─── LLM spend ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."llm_spend_monthly" AS
SELECT
  lu.client_id,
  c.name AS client_name,
  c.domain,
  date_trunc('month', lu.timestamp)::date AS month,
  lu.module,
  lu.tier,
  sum(lu.input_tokens) AS input_tokens,
  sum(lu.output_tokens) AS output_tokens,
  sum(lu.cost)::numeric(12, 4) AS cost_usd
FROM "public"."llm_usage" lu
JOIN "reporting"."clients_safe" c USING (client_id)
GROUP BY lu.client_id, c.name, c.domain, date_trunc('month', lu.timestamp), lu.module, lu.tier;
--> statement-breakpoint

-- ─── Job health ───────────────────────────────────────────────────────────────
-- job_executions.client_id is nullable (global jobs), so LEFT JOIN preserves them.
CREATE OR REPLACE VIEW "reporting"."job_failures_recent" AS
SELECT
  je.id,
  je.job_name,
  je.client_id,
  c.name AS client_name,
  c.domain,
  je.status,
  je.started_at,
  je.completed_at,
  je.duration_ms,
  je.error,
  je.metadata
FROM "public"."job_executions" je
LEFT JOIN "reporting"."clients_safe" c USING (client_id)
WHERE je.status IN ('failed', 'error')
  AND je.started_at >= now() - interval '48 hours';
--> statement-breakpoint

-- ─── Approval queue ───────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."pending_approvals" AS
SELECT
  al.id,
  al.client_id,
  c.name AS client_name,
  c.domain,
  al.module,
  al.action,
  al.description,
  al.rationale,
  al.risk_level,
  al.reversible,
  al.status,
  al.ai_recommendation,
  al.ai_confidence,
  al.estimated_impact,
  al.created_at,
  al.expires_at,
  CASE al.risk_level
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    ELSE 4
  END AS risk_rank
FROM "public"."action_log" al
JOIN "reporting"."clients_safe" c USING (client_id)
WHERE al.status = 'pending_approval';
--> statement-breakpoint

-- ─── Link prospects ready for outreach ────────────────────────────────────────
CREATE OR REPLACE VIEW "reporting"."link_prospects_uncontacted" AS
SELECT
  lp.client_id,
  c.name AS client_name,
  c.domain,
  lp.target_url,
  lp.contact_email,
  lp.domain_rating,
  lp.relevance_score,
  lp.tactic,
  lp.status,
  lp.created_at
FROM "public"."link_prospects" lp
JOIN "reporting"."clients_safe" c USING (client_id)
WHERE lp.status = 'discovered';
--> statement-breakpoint

-- ─── Materialized portfolio layer ─────────────────────────────────────────────
-- Refreshed by the app scheduler (reporting:refresh-materialized), never by an
-- ad-hoc agent session. Each carries a UNIQUE index so REFRESH ... CONCURRENTLY
-- is available (it is not, without one).
CREATE MATERIALIZED VIEW IF NOT EXISTS "reporting"."mv_llm_spend_monthly" AS
SELECT * FROM "reporting"."llm_spend_monthly";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mv_llm_spend_monthly_unique"
ON "reporting"."mv_llm_spend_monthly" (client_id, month, module, tier);
--> statement-breakpoint

CREATE MATERIALIZED VIEW IF NOT EXISTS "reporting"."mv_aeo_citation_rate_monthly" AS
SELECT * FROM "reporting"."aeo_citation_rate_monthly";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mv_aeo_citation_rate_monthly_unique"
ON "reporting"."mv_aeo_citation_rate_monthly" (client_id, month, platform);
--> statement-breakpoint

-- keyword_hash, not keyword: a varchar(500) key can exceed the btree tuple limit
-- and would fail at refresh time rather than at migration time.
CREATE MATERIALIZED VIEW IF NOT EXISTS "reporting"."mv_weekly_keyword_movements" AS
SELECT * FROM "reporting"."weekly_keyword_movements";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mv_weekly_keyword_movements_unique"
ON "reporting"."mv_weekly_keyword_movements" (client_id, keyword_hash, device, week_start);
--> statement-breakpoint

-- ─── Refresh bookkeeping ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reporting"."refresh_log" (
	"view_name" text PRIMARY KEY NOT NULL,
	"refreshed_at" timestamp DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint

-- ─── Query audit ──────────────────────────────────────────────────────────────
-- Every gateway query is audited before it runs; an unauditable query does not
-- run (fail-closed). Direct psql clients are covered by DB logs + application_name.
CREATE TABLE IF NOT EXISTS "reporting"."query_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"actor_type" text NOT NULL,
	"surface" text NOT NULL,
	"query_name" text,
	"sql_hash" text,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer,
	"duration_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "query_audit_log_actor_type_check"
	  CHECK ("actor_type" IN ('human', 'agent', 'api', 'system'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_audit_created" ON "reporting"."query_audit_log" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_query_audit_actor" ON "reporting"."query_audit_log" ("actor_type", "created_at");
--> statement-breakpoint

-- ─── Latest-state / window indexes on the operational tables ──────────────────
-- Composite + time-ordered, shaped for the "latest row per entity" and
-- "movement over a window" questions the views above ask.
CREATE INDEX IF NOT EXISTS "idx_serp_latest_lookup"
ON "public"."serp_rankings" ("client_id", "keyword", "device", "checked_at" DESC)
INCLUDE ("position", "previous_position", "url");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vitals_latest_lookup"
ON "public"."web_vitals" ("client_id", "url", "device", "source", "measured_at" DESC)
INCLUDE ("lcp", "inp", "cls", "rating");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engagement_latest_lookup"
ON "public"."page_engagement" ("client_id", "page_path", "period", "computed_at" DESC)
INCLUDE ("exit_rate", "bounce_rate", "avg_time_on_page", "avg_scroll_depth", "total_pageviews");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aeo_monthly_platform"
ON "public"."aeo_citations" ("client_id", "platform", "checked_at" DESC)
INCLUDE ("cited", "competitor_cited");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_client_time"
ON "public"."llm_usage" ("client_id", "timestamp" DESC)
INCLUDE ("module", "tier", "cost", "input_tokens", "output_tokens");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_status_started"
ON "public"."job_executions" ("status", "started_at" DESC)
INCLUDE ("job_name", "client_id", "duration_ms");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_actions_status_created"
ON "public"."action_log" ("status", "created_at" DESC)
INCLUDE ("client_id", "module", "action", "risk_level", "reversible");
