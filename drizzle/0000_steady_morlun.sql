CREATE TABLE IF NOT EXISTS "action_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"module" varchar(50) NOT NULL,
	"action" text NOT NULL,
	"executed_at" timestamp NOT NULL,
	"measured_at" timestamp,
	"position_before" integer,
	"position_after" integer,
	"traffic_before" integer,
	"traffic_after" integer,
	"success" boolean,
	"learnings" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "aeo_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"query" text NOT NULL,
	"platform" varchar(50) NOT NULL,
	"cited" boolean DEFAULT false NOT NULL,
	"cited_url" text,
	"competitor_cited" varchar(255),
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"posthog_project_id" varchar(100),
	"posthog_api_key" varchar(255),
	"industry" varchar(100) NOT NULL,
	"city" varchar(100),
	"state" varchar(2),
	"country" varchar(2) DEFAULT 'US',
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clients_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"competitor_domain" varchar(255) NOT NULL,
	"keyword" varchar(500) NOT NULL,
	"position" integer,
	"url" text,
	"title" text,
	"snippet" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "faq_optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_injected" boolean DEFAULT false,
	"last_updated" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gap_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"keyword" varchar(500) NOT NULL,
	"client_url" text,
	"competitor_url" text,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surpass_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'pending',
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" varchar(100) NOT NULL,
	"client_id" uuid,
	"status" varchar(20) NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration_ms" integer,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "link_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"contact_email" varchar(255),
	"contact_name" varchar(255),
	"domain_rating" integer,
	"relevance_score" real,
	"tactic" varchar(50) NOT NULL,
	"status" varchar(50) DEFAULT 'discovered' NOT NULL,
	"outreach_sequence" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"module" varchar(50) NOT NULL,
	"tier" varchar(20) NOT NULL,
	"purpose" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost" real NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"page_path" varchar(500) NOT NULL,
	"avg_time_on_page" real,
	"avg_scroll_depth" real,
	"bounce_rate" real,
	"exit_rate" real,
	"unique_visitors" integer,
	"total_pageviews" integer,
	"period" varchar(30) NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "serp_rankings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"keyword" varchar(500) NOT NULL,
	"position" integer,
	"previous_position" integer,
	"url" text,
	"serp_features" jsonb DEFAULT '[]'::jsonb,
	"device" varchar(10) DEFAULT 'desktop',
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "web_vitals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"url" text NOT NULL,
	"source" varchar(20) NOT NULL,
	"lcp" real,
	"inp" real,
	"cls" real,
	"fcp" real,
	"ttfb" real,
	"rating" varchar(20),
	"device" varchar(10) DEFAULT 'mobile',
	"measured_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"module" varchar(50) NOT NULL,
	"action" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"rationale" text NOT NULL,
	"triggered_by" text NOT NULL,
	"risk_level" varchar(20) NOT NULL,
	"reversible" boolean NOT NULL,
	"status" varchar(30) DEFAULT 'pending_approval' NOT NULL,
	"options" jsonb,
	"ai_recommendation" text,
	"ai_confidence" real,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"selected_option" varchar(50),
	"rejection_reason" text,
	"executed_at" timestamp,
	"execution_result" text,
	"estimated_impact" varchar(20),
	"resolved_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behavior_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"insight" text NOT NULL,
	"severity" varchar(20) NOT NULL,
	"page_path" varchar(500),
	"metric" varchar(50),
	"current_value" real,
	"benchmark_value" real,
	"options" jsonb NOT NULL,
	"ai_recommended_option" varchar(50),
	"ai_rationale" text,
	"selected_option" varchar(50),
	"resolved_by" varchar(50),
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"week_of" varchar(10) NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action_outcomes" ADD CONSTRAINT "action_outcomes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "aeo_citations" ADD CONSTRAINT "aeo_citations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "faq_optimizations" ADD CONSTRAINT "faq_optimizations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gap_analyses" ADD CONSTRAINT "gap_analyses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "link_prospects" ADD CONSTRAINT "link_prospects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_engagement" ADD CONSTRAINT "page_engagement_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "serp_rankings" ADD CONSTRAINT "serp_rankings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_vitals" ADD CONSTRAINT "web_vitals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action_log" ADD CONSTRAINT "action_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "behavior_recommendations" ADD CONSTRAINT "behavior_recommendations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_name" ON "job_executions" USING btree ("job_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_started" ON "job_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_links_client_status" ON "link_prospects" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_engagement_client_period" ON "page_engagement" USING btree ("client_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_serp_client_keyword" ON "serp_rankings" USING btree ("client_id","keyword");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_serp_checked_at" ON "serp_rankings" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_vitals_client_url" ON "web_vitals" USING btree ("client_id","url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_action_log_client_status" ON "action_log" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_action_log_created" ON "action_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_behavior_rec_client_week" ON "behavior_recommendations" USING btree ("client_id","week_of");