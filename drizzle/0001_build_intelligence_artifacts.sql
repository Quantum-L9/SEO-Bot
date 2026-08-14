CREATE TABLE IF NOT EXISTS "build_intelligence_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"build_id" varchar(255) NOT NULL,
	"artifact_type" varchar(64) NOT NULL,
	"artifact_id" varchar(128) NOT NULL,
	"payload_digest" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"produced_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "build_intelligence_artifacts_artifact_id_unique" UNIQUE("artifact_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_build_intel_client_build" ON "build_intelligence_artifacts" USING btree ("client_id","build_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_build_intel_type" ON "build_intelligence_artifacts" USING btree ("artifact_type");
