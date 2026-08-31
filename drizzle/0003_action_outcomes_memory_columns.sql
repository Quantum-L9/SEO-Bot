-- Repair pre-existing schema drift on `action_outcomes`.
--
-- `src/core/database/schema.ts` has declared three columns since the memory
-- promotion work landed:
--
--   memory_record_id      uuid
--   memory_promoted_at    timestamp
--   memory_promotion_error text
--
-- No migration ever created them. Drizzle names every declared column in the
-- SELECT list, so ANY read of `action_outcomes` against a database built from
-- these migration files fails with:
--
--   error: column "memory_record_id" does not exist
--
-- That includes the live `GET /api/token-budget` route, which selects from this
-- table on every call. The drift went unnoticed because no test had ever run a
-- query against a migration-built database — the intelligence suite is the
-- first to do so, and it failed here immediately.
--
-- Strictly additive and nullable: applying this to a database where the columns
-- were added by hand is a no-op, and applying it where they are genuinely
-- missing repairs the reads without touching existing rows.

ALTER TABLE "action_outcomes" ADD COLUMN IF NOT EXISTS "memory_record_id" uuid;--> statement-breakpoint
ALTER TABLE "action_outcomes" ADD COLUMN IF NOT EXISTS "memory_promoted_at" timestamp;--> statement-breakpoint
ALTER TABLE "action_outcomes" ADD COLUMN IF NOT EXISTS "memory_promotion_error" text;
