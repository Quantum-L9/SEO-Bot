-- Intelligence control loop (INTEL).
--
-- Strictly ADDITIVE: five new tables, no column added to or removed from an
-- existing one, no data backfill. Applying this to a populated database changes
-- nothing an existing query can observe, and rolling the application back with
-- the tables in place is harmless — they are simply unused.
--
-- Hand-authored, matching 0001. `drizzle-kit generate` cannot load this repo's
-- schema (its CJS loader fails on the ESM `./schema.js` specifier in
-- schema-extensions.ts), so generated migrations are not available here. See
-- docs/INTELLIGENCE_TESTING.md.
--
-- IF NOT EXISTS throughout so re-application is a no-op.

CREATE TABLE IF NOT EXISTS "intelligence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"run_type" varchar(40) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"error" text,
	"signals_written" integer DEFAULT 0 NOT NULL,
	"opportunities_written" integer DEFAULT 0 NOT NULL,
	"decisions_written" integer DEFAULT 0 NOT NULL,
	"jobs_routed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"run_id" uuid,
	"signal_type" varchar(50) NOT NULL,
	"fingerprint" varchar(128) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"first_observed_at" timestamp DEFAULT now() NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_type" varchar(50) NOT NULL,
	"fingerprint" varchar(128) NOT NULL,
	"score" real NOT NULL,
	"impact" real NOT NULL,
	"confidence" real NOT NULL,
	"effort" real NOT NULL,
	"risk" real NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"signal_fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"run_id" uuid,
	"opportunity_id" uuid,
	"mode" varchar(20) NOT NULL,
	"source" varchar(20) NOT NULL,
	"proposed_action" varchar(100) NOT NULL,
	"decision" varchar(20) NOT NULL,
	"blocked_reason" text,
	"action_log_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intelligence_action_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"job_name" varchar(100),
	"job_id" varchar(255),
	"action_log_id" uuid,
	"linked_at" timestamp DEFAULT now() NOT NULL
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
 ALTER TABLE "intelligence_decisions" ADD CONSTRAINT "intelligence_decisions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
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
-- The idempotency keys. These UNIQUE indexes are what make a BullMQ retry a
-- no-op rather than a duplicate: the upserts in signal-extractor.ts and
-- opportunity-scorer.ts, and the routing claim in action-router.ts, all
-- conflict-target exactly these.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_intel_signals_client_fingerprint" ON "intelligence_signals" USING btree ("client_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_intel_opps_client_fingerprint" ON "intelligence_opportunities" USING btree ("client_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_intel_links_client_opp_job" ON "intelligence_action_links" USING btree ("client_id","opportunity_id","job_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_runs_client_type" ON "intelligence_runs" USING btree ("client_id","run_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_runs_started" ON "intelligence_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_client_type" ON "intelligence_signals" USING btree ("client_id","signal_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_signals_client_status" ON "intelligence_signals" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_opps_client_score" ON "intelligence_opportunities" USING btree ("client_id","score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_opps_client_status" ON "intelligence_opportunities" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_client" ON "intelligence_decisions" USING btree ("client_id","decision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_decisions_created" ON "intelligence_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_intel_links_client" ON "intelligence_action_links" USING btree ("client_id");
