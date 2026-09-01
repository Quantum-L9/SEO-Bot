CREATE TABLE IF NOT EXISTS "intelligence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"run_type" varchar(40) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"error" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"signal_type" varchar(50) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"entity_key" varchar(500) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"strength" real DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_signal_client_fingerprint" UNIQUE("client_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_type" varchar(50) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"impact" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"effort" real DEFAULT 0 NOT NULL,
	"risk" real DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"signal_fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_opp_client_fingerprint" UNIQUE("client_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_action_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"job_name" varchar(100),
	"job_id" varchar(200),
	"action_log_id" uuid,
	"action" varchar(100) NOT NULL,
	"outcome" varchar(30) DEFAULT 'proposed' NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_intel_link_client_opp_job" UNIQUE("client_id","opportunity_id","job_name")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_runs" ADD CONSTRAINT "intelligence_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
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
 ALTER TABLE "intelligence_opportunities" ADD CONSTRAINT "intelligence_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intelligence_action_links" ADD CONSTRAINT "intelligence_action_links_opportunity_id_intelligence_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."intelligence_opportunities"("id") ON DELETE no action ON UPDATE no action;
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
CREATE INDEX IF NOT EXISTS "idx_intel_links_client_opp" ON "intelligence_action_links" USING btree ("client_id","opportunity_id");
