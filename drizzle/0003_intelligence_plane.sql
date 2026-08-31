-- ═══════════════════════════════════════════════════════════════════════════════
-- SEO-Bot Intelligence Plane (ADR-0016)
--
-- Operational tables record FACTS. These tables record INTERPRETATION:
-- every autonomous reasoning cycle, the signals it extracted, the opportunities
-- it grouped them into, the decisions it took and why, the policy state that
-- gated it, and the measurement windows that tell it whether it was right.
--
-- Nothing here mutates a client site. Execution stays with the existing
-- modules / scheduler / execution-policy approval flow.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "intelligence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"run_type" varchar(80) NOT NULL,
	"trigger_source" varchar(40) NOT NULL,
	"status" varchar(30) DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration_ms" integer,
	"llm_used" boolean DEFAULT false NOT NULL,
	"total_cost" numeric(12, 6) DEFAULT '0',
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint

-- A signal is a machine-readable OBSERVATION, never an action.
-- `fingerprint` is the stable identity of "this observation about this entity";
-- UNIQUE(run_id, fingerprint) makes a retried run idempotent (BullMQ is
-- at-least-once, and AGENTS §7 requires idempotent handlers). The separate
-- (client_id, fingerprint, observed_at DESC) index serves suppression lookups.
CREATE TABLE IF NOT EXISTS "intelligence_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" text,
	"signal_type" varchar(80) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"suppressed_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intelligence_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client_id" uuid NOT NULL,
	"opportunity_type" varchar(80) NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"target_url" text,
	"target_keyword" text,
	"expected_impact" numeric(8, 4),
	"effort" numeric(8, 4),
	"risk" numeric(8, 4),
	"urgency" numeric(8, 4),
	"confidence" numeric(5, 4),
	"score" numeric(10, 4) NOT NULL,
	"status" varchar(40) DEFAULT 'open' NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intelligence_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"decision_type" varchar(80) NOT NULL,
	"decision" varchar(40) NOT NULL,
	"rationale" text NOT NULL,
	"policy_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"action_log_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Attribution wrapper around the existing action_outcomes row: an SEO change
-- needs a baseline window and a measurement window before "did it work?" means
-- anything.
CREATE TABLE IF NOT EXISTS "intelligence_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"action_outcome_id" uuid,
	"decision_id" uuid,
	"hypothesis" text NOT NULL,
	"target_metric" varchar(80) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" text NOT NULL,
	"baseline_start" timestamp NOT NULL,
	"baseline_end" timestamp NOT NULL,
	"measurement_start" timestamp NOT NULL,
	"measurement_end" timestamp NOT NULL,
	"status" varchar(40) DEFAULT 'measuring' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The autonomous governors (link velocity, ranking circuit breaker, LLM budget)
-- as SQL-readable state rather than checks scattered across modules.
CREATE TABLE IF NOT EXISTS "intelligence_policy_state" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"autonomous_actions_paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"daily_llm_budget_remaining" numeric(12, 6),
	"outreach_capacity_remaining" integer,
	"ranking_circuit_open" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "intelligence_runs" ADD CONSTRAINT "intelligence_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_signals" ADD CONSTRAINT "intelligence_signals_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."intelligence_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_signals" ADD CONSTRAINT "intelligence_signals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_opportunities" ADD CONSTRAINT "intelligence_opportunities_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."intelligence_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_opportunities" ADD CONSTRAINT "intelligence_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."intelligence_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_opportunity_id_intelligence_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."intelligence_opportunities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_experiments" ADD CONSTRAINT "intelligence_experiments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_experiments" ADD CONSTRAINT "intelligence_experiments_action_outcome_id_action_outcomes_id_fk" FOREIGN KEY ("action_outcome_id") REFERENCES "public"."action_outcomes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_experiments" ADD CONSTRAINT "intelligence_experiments_decision_id_intelligence_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."intelligence_decisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_policy_state" ADD CONSTRAINT "intelligence_policy_state_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_intel_runs_type_started" ON "intelligence_runs" ("run_type", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_runs_client_started" ON "intelligence_runs" ("client_id", "started_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_intel_signals_run_fingerprint" ON "intelligence_signals" ("run_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_client_fingerprint" ON "intelligence_signals" ("client_id", "fingerprint", "observed_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_client_type" ON "intelligence_signals" ("client_id", "signal_type", "observed_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_intel_opportunities_run_fingerprint" ON "intelligence_opportunities" ("run_id", "fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_opportunities_client_status" ON "intelligence_opportunities" ("client_id", "status", "score" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_client_created" ON "intelligence_decisions" ("client_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_opportunity" ON "intelligence_decisions" ("opportunity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_experiments_status_window" ON "intelligence_experiments" ("status", "measurement_end");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_experiments_client" ON "intelligence_experiments" ("client_id", "created_at" DESC);
