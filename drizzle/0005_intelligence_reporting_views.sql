-- ═══════════════════════════════════════════════════════════════════════════════
-- SEO-Bot Intelligence Reporting Views (ADR-0015 + ADR-0016, contract C4)
--
-- The intelligence plane records its reasoning as rows and nothing could read
-- them but psql. That is the manual work the planes were built to remove: the
-- operator's daily job is reviewing what the bot concluded, and doing it meant
-- hand-writing joins across four tables.
--
-- These views put that reasoning behind the SAME gateway as everything else —
-- audited before execution, read-only, per-audience projections, statement
-- timeout — rather than letting the dashboard query the tables directly. A
-- dashboard that reaches past the gateway is a second, unaudited read path, and
-- the audit log exists precisely so there is only one.
--
-- `rationale`, `learnings` and `title` are MODEL-AUTHORED FREE TEXT. Nothing is
-- escaped here — escaping belongs at the render site, where the output format is
-- known — but every consumer of these views must treat them as hostile.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Live opportunities ───────────────────────────────────────────────────────
-- `open` and `actioned` only: the lifecycle (contract C3) is what makes this a
-- work list rather than a growing history. A resolved or expired opportunity is
-- answered and does not belong on a queue.
CREATE OR REPLACE VIEW "reporting"."intelligence_opportunities_live" AS
SELECT
  o.id AS opportunity_id,
  o.client_id,
  c.name AS client_name,
  c.domain,
  o.opportunity_type,
  o.title,
  o.description,
  o.target_url,
  o.target_keyword,
  o.score::numeric(10, 4) AS score,
  o.urgency::numeric(8, 4) AS urgency,
  o.confidence::numeric(5, 4) AS confidence,
  o.status,
  o.created_at,
  o.updated_at
FROM "public"."intelligence_opportunities" o
JOIN "reporting"."clients_safe" c USING (client_id)
WHERE o.status IN ('open', 'actioned');
--> statement-breakpoint

-- ─── Recent decisions ─────────────────────────────────────────────────────────
-- The "why did the bot do that?" view. `blockers` is lifted out of policy_basis
-- because it is the part an operator actually reads — the whole JSON blob on a
-- dashboard row is noise.
CREATE OR REPLACE VIEW "reporting"."intelligence_decisions_recent" AS
SELECT
  d.id AS decision_id,
  d.client_id,
  c.name AS client_name,
  c.domain,
  d.decision_type,
  d.decision,
  d.rationale,
  d.requires_approval,
  d.action_log_id,
  o.title AS opportunity_title,
  o.status AS opportunity_status,
  (d.policy_basis -> 'blockers') AS blockers,
  (d.policy_basis ->> 'score')::numeric AS opportunity_score,
  d.created_at
FROM "public"."intelligence_decisions" d
JOIN "reporting"."clients_safe" c USING (client_id)
LEFT JOIN "public"."intelligence_opportunities" o ON o.id = d.opportunity_id
WHERE d.created_at >= now() - interval '30 days';
--> statement-breakpoint

-- ─── Experiments awaiting measurement ─────────────────────────────────────────
-- An SEO change has no observable effect on the day it ships, so "waiting" is
-- the normal state and `days_remaining` is what turns a wait into a date.
CREATE OR REPLACE VIEW "reporting"."intelligence_experiments_pending" AS
SELECT
  e.id AS experiment_id,
  e.client_id,
  c.name AS client_name,
  c.domain,
  e.hypothesis,
  e.target_metric,
  e.entity_type,
  e.entity_id,
  e.measurement_start,
  e.measurement_end,
  GREATEST(0, EXTRACT(DAY FROM (e.measurement_end - now()))::int) AS days_remaining,
  e.status,
  e.created_at
FROM "public"."intelligence_experiments" e
JOIN "reporting"."clients_safe" c USING (client_id)
WHERE e.status = 'measuring';
--> statement-breakpoint

-- ─── Measured outcomes ────────────────────────────────────────────────────────
-- Did it work? Joined to action_outcomes because that is the row the memory
-- promoter reads: showing the operator a different number from the one the bot
-- learns from would be worse than showing none.
CREATE OR REPLACE VIEW "reporting"."intelligence_outcomes_measured" AS
SELECT
  e.id AS experiment_id,
  e.client_id,
  c.name AS client_name,
  c.domain,
  e.target_metric,
  e.entity_id,
  e.status,
  (e.result ->> 'verdict') AS verdict,
  (e.result -> 'comparison' ->> 'baseline')::numeric AS baseline,
  (e.result -> 'comparison' ->> 'measured')::numeric AS measured,
  (e.result -> 'comparison' ->> 'delta')::numeric AS delta,
  ao.module,
  ao.action,
  ao.success,
  ao.learnings,
  ao.executed_at,
  ao.measured_at
FROM "public"."intelligence_experiments" e
JOIN "reporting"."clients_safe" c USING (client_id)
LEFT JOIN "public"."action_outcomes" ao ON ao.id = e.action_outcome_id
WHERE e.status IN ('measured', 'inconclusive');
--> statement-breakpoint

-- ─── Supporting indexes ───────────────────────────────────────────────────────
-- The dashboard asks each of these per client, newest or highest first.
CREATE INDEX IF NOT EXISTS "idx_intel_opportunities_live_lookup"
ON "public"."intelligence_opportunities" ("client_id", "score" DESC)
WHERE "status" IN ('open', 'actioned');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_experiments_measuring"
ON "public"."intelligence_experiments" ("client_id", "measurement_end")
WHERE "status" = 'measuring';
