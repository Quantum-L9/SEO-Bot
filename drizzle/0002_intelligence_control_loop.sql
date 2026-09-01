CREATE TABLE IF NOT EXISTS "intelligence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"run_type" varchar(80) NOT NULL,
	"trigger_source" varchar(40) DEFAULT 'scheduler' NOT NULL,
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
CREATE TABLE IF NOT EXISTS "intelligence_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client_id" uuid NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_key" text NOT NULL,
	"signal_type" varchar(80) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"status" varchar(30) DEFAULT 'open' NOT NULL,
	"suppressed_until" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_signal_client_fingerprint" UNIQUE("client_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client_id" uuid NOT NULL,
	"opportunity_type" varchar(80) NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"target_url" text,
	"target_keyword" text,
	"fingerprint" text NOT NULL,
	"expected_impact" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"urgency" real DEFAULT 0 NOT NULL,
	"effort" real DEFAULT 0 NOT NULL,
	"risk" real DEFAULT 0 NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"status" varchar(40) DEFAULT 'open' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signal_fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_opp_client_fingerprint" UNIQUE("client_id","fingerprint")
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
CREATE TABLE IF NOT EXISTS "intelligence_action_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"decision_id" uuid,
	"action_log_id" uuid,
	"job_name" varchar(100),
	"job_id" text,
	"action_outcome_id" uuid,
	"action" varchar(100) NOT NULL,
	"status" varchar(40) DEFAULT 'queued' NOT NULL,
	"blocked_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_link_client_opp_job" UNIQUE("client_id","opportunity_id","job_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"action_outcome_id" uuid,
	"hypothesis" text NOT NULL,
	"target_metric" varchar(80) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_key" text NOT NULL,
	"baseline_start" timestamp NOT NULL,
	"baseline_end" timestamp NOT NULL,
	"measurement_start" timestamp NOT NULL,
	"measurement_end" timestamp NOT NULL,
	"status" varchar(40) DEFAULT 'measuring' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_runs" ADD CONSTRAINT "intelligence_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_signals" ADD CONSTRAINT "intelligence_signals_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."intelligence_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_signals" ADD CONSTRAINT "intelligence_signals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "intelligence_opportunities" ADD CONSTRAINT "intelligence_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_action_log_id_action_log_id_fk" FOREIGN KEY ("action_log_id") REFERENCES "public"."action_log"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_opportunity_id_intelligence_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."intelligence_opportunities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_decision_id_intelligence_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."intelligence_decisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_action_log_id_action_log_id_fk" FOREIGN KEY ("action_log_id") REFERENCES "public"."action_log"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_action_outcome_id_action_outcomes_id_fk" FOREIGN KEY ("action_outcome_id") REFERENCES "public"."action_outcomes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_experiments" ADD CONSTRAINT "intelligence_experiments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_experiments" ADD CONSTRAINT "intelligence_experiments_opportunity_id_intelligence_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."intelligence_opportunities"("id") ON DELETE set null ON UPDATE no action;
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
CREATE INDEX IF NOT EXISTS "idx_intel_runs_client_started" ON "intelligence_runs" USING btree ("client_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_runs_status" ON "intelligence_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_client_type" ON "intelligence_signals" USING btree ("client_id","signal_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_observed" ON "intelligence_signals" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_opps_client_score" ON "intelligence_opportunities" USING btree ("client_id","score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_opps_client_status" ON "intelligence_opportunities" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_client_created" ON "intelligence_decisions" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_opportunity" ON "intelligence_decisions" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_links_client_opp" ON "intelligence_action_links" USING btree ("client_id","opportunity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_experiments_client_status" ON "intelligence_experiments" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_experiments_measure_end" ON "intelligence_experiments" USING btree ("measurement_end");
