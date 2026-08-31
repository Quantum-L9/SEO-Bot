-- ═══════════════════════════════════════════════════════════════════════════════
-- SEO-Bot Reporting SQL Plane — role provisioning (ADR-0015)
--
-- Run by an operator with role-creation rights, AFTER migrations 0002 and 0004
-- have applied (the grants below target objects those migrations create).
-- Re-runnable, and re-running it is how a privilege NARROWING reaches an
-- existing install — see the REVOKE on the benchmark role below.
--
--   psql "$SUPERUSER_DATABASE_URL" \
--     -v ON_ERROR_STOP=1 \
--     -v db_name="$(psql "$DATABASE_URL" -Atc 'select current_database()')" \
--     -v human_password="$(openssl rand -base64 24)" \
--     -v agent_password="$(openssl rand -base64 24)" \
--     -v benchmark_password="$(openssl rand -base64 24)" \
--     -f scripts/reporting/provision-roles.sql
--
-- Passwords are psql variables, never literals in this file, and this file must
-- never be edited to contain one. Store the generated values in the secrets
-- plane (Infisical, per ADR-0009) alongside the application's own credentials.
--
-- WHY THESE ROLES EXIST AT ALL, given the API gateway:
--   The gateway (/api/reporting/query) is the path everything AUTOMATED should
--   use — it audits centrally, enforces the view allow-list, and validates
--   parameters. These roles are for the case the gateway cannot serve: an
--   operator at a psql prompt or in an IDE, exploring. They are scoped so that
--   even that session cannot read a credential or write a row.
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT GRANT:
--   No access to `public` at all. Not SELECT, not USAGE. `public.clients` holds
--   posthog_api_key, so a plain `SELECT * FROM clients` by a reporting session
--   must be impossible rather than merely discouraged.
-- ═══════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- ─── Revoke the implicit grants Postgres hands to PUBLIC ─────────────────────
-- Without this, every login role can create objects in `public` and connect to
-- the database, which makes the least-privilege roles below decorative.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;

-- ─── Shared base role: connect + see the reporting schema, nothing more ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_reporting_base') THEN
    CREATE ROLE seo_reporting_base NOLOGIN;
  END IF;
END $$;

GRANT CONNECT ON DATABASE :"db_name" TO seo_reporting_base;
GRANT USAGE ON SCHEMA reporting TO seo_reporting_base;

-- ─── Login roles ─────────────────────────────────────────────────────────────
-- seo_human_reporting  — operator at a psql/IDE prompt. Sees names and domains.
-- seo_agent_reporting  — LLM tooling. Masked views only, short timeout.
-- seo_benchmark_reporting — cross-client aggregates, no client identity at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_human_reporting') THEN
    CREATE ROLE seo_human_reporting LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_agent_reporting') THEN
    CREATE ROLE seo_agent_reporting LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_benchmark_reporting') THEN
    CREATE ROLE seo_benchmark_reporting LOGIN;
  END IF;
END $$;

ALTER ROLE seo_human_reporting     PASSWORD :'human_password';
ALTER ROLE seo_agent_reporting     PASSWORD :'agent_password';
ALTER ROLE seo_benchmark_reporting PASSWORD :'benchmark_password';

GRANT seo_reporting_base TO seo_human_reporting;
GRANT seo_reporting_base TO seo_agent_reporting;
GRANT seo_reporting_base TO seo_benchmark_reporting;

-- ─── Session defaults ────────────────────────────────────────────────────────
-- search_path excludes `public`, so an unqualified table name in an ad-hoc query
-- resolves to a reporting view or fails — it never silently reaches a base table.
ALTER ROLE seo_human_reporting     SET search_path = reporting, pg_temp;
ALTER ROLE seo_agent_reporting     SET search_path = reporting, pg_temp;
ALTER ROLE seo_benchmark_reporting SET search_path = reporting, pg_temp;

-- Read-only by default. Combined with the absent INSERT/UPDATE/DELETE grants
-- this is belt and braces, and the belt is the one that catches a future view
-- that turns out to be updatable.
ALTER ROLE seo_human_reporting     SET default_transaction_read_only = on;
ALTER ROLE seo_agent_reporting     SET default_transaction_read_only = on;
ALTER ROLE seo_benchmark_reporting SET default_transaction_read_only = on;

-- A runaway ad-hoc query must not hold a connection on the box that also runs
-- the bot. Agents get the tighter budget: they retry, humans reconsider.
ALTER ROLE seo_agent_reporting     SET statement_timeout = '5000ms';
ALTER ROLE seo_agent_reporting     SET idle_in_transaction_session_timeout = '5000ms';
ALTER ROLE seo_human_reporting     SET statement_timeout = '15000ms';
ALTER ROLE seo_human_reporting     SET idle_in_transaction_session_timeout = '15000ms';
ALTER ROLE seo_benchmark_reporting SET statement_timeout = '15000ms';
ALTER ROLE seo_benchmark_reporting SET idle_in_transaction_session_timeout = '15000ms';

-- Distinguishable in pg_stat_activity and the database logs, which is the audit
-- trail for direct sessions (the gateway audits its own in reporting.query_audit_log).
ALTER ROLE seo_human_reporting     SET application_name = 'seo-reporting:human';
ALTER ROLE seo_agent_reporting     SET application_name = 'seo-reporting:agent';
ALTER ROLE seo_benchmark_reporting SET application_name = 'seo-reporting:benchmark';

-- ─── Grants: named views only, never a base table ────────────────────────────
-- Operator surface: client identity is permitted.
GRANT SELECT ON
  reporting.clients_safe,
  reporting.latest_serp_rankings,
  reporting.keyword_drops_7d,
  reporting.weekly_keyword_movements,
  reporting.mv_weekly_keyword_movements,
  reporting.page_experience_risks,
  reporting.aeo_citation_rate_monthly,
  reporting.mv_aeo_citation_rate_monthly,
  reporting.llm_spend_monthly,
  reporting.mv_llm_spend_monthly,
  reporting.portfolio_benchmarks,
  reporting.mv_portfolio_benchmarks,
  reporting.portfolio_cohort_coverage,
  reporting.mv_portfolio_cohort_coverage,
  reporting.job_failures_recent,
  reporting.pending_approvals,
  reporting.link_prospects_uncontacted,
  reporting.refresh_log
TO seo_human_reporting;

-- Agent surface: masked client dimension, no name/domain/contact anywhere.
-- link_prospects_uncontacted and pending_approvals are absent on purpose:
-- the first carries contact PII, the second carries client identity.
GRANT SELECT ON
  reporting.clients_agent,
  reporting.mv_weekly_keyword_movements,
  reporting.page_experience_risks,
  reporting.mv_aeo_citation_rate_monthly,
  reporting.mv_llm_spend_monthly,
  reporting.job_failures_recent,
  reporting.refresh_log
TO seo_agent_reporting;

-- Benchmark surface: cohort statistics ONLY.
--
-- This role used to be granted the same per-tenant monthly matviews as the agent
-- role. Those carry client_id, so a role whose entire purpose is "cross-client
-- aggregates with no client identity at all" could read per-tenant rows — the
-- gap contract C1 exists to close. The REVOKE below is therefore load-bearing on
-- an existing install: this script is re-runnable, and a GRANT alone would leave
-- yesterday's wider privileges in place.
REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM seo_benchmark_reporting;

GRANT SELECT ON
  reporting.portfolio_benchmarks,
  reporting.mv_portfolio_benchmarks,
  reporting.portfolio_cohort_coverage,
  reporting.mv_portfolio_cohort_coverage
TO seo_benchmark_reporting;

-- Deliberately NOT granted to any role: reporting.client_period_metrics. It is
-- the per-client rollup the benchmark aggregates over, and it exists only to be
-- aggregated. Neither the registry nor any grant reaches it.

-- The audit log is append-only from the application's perspective and readable
-- by the operator for review. Agents cannot read it: an actor able to read the
-- record of its own queries is an actor able to shop for gaps in it.
GRANT SELECT ON reporting.query_audit_log TO seo_human_reporting;

-- ─── Explicitly deny what silence would otherwise permit later ───────────────
-- Default privileges do not apply retroactively, but they do decide what a
-- FUTURE view in this schema grants. Nothing is granted by default, so a new
-- view is unreachable until someone deliberately adds it above.
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting REVOKE ALL ON TABLES FROM PUBLIC;

-- ─── Verification (prints; does not enforce) ─────────────────────────────────
\echo '── Reporting roles provisioned. Verify least privilege: ──'
SELECT
  grantee,
  count(*) FILTER (WHERE table_schema = 'reporting') AS reporting_grants,
  count(*) FILTER (WHERE table_schema = 'public')    AS public_grants
FROM information_schema.role_table_grants
WHERE grantee IN ('seo_human_reporting', 'seo_agent_reporting', 'seo_benchmark_reporting')
GROUP BY grantee
ORDER BY grantee;
\echo '── public_grants MUST be 0 for every row above. ──'
