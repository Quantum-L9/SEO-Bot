/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Database Migration Runner
 * Run with: pnpm migrate
 *
 * --check performs a dry run: it compares migration files on disk against the
 * drizzle-managed migrations-history table and reports pending migrations
 * without executing any SQL other than a read-only SELECT against that history
 * table. This mirrors the exact pending-migration logic drizzle-orm's
 * PgDialect.migrate() uses internally.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createModuleLogger } from "../logger.js";
import { hydrateSecretsIfConfigured } from "../secrets.js";
import { closeDb, getDb } from "./index.js";

const logger = createModuleLogger("migrate");

const MIGRATIONS_FOLDER = "./drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_SCHEMA = "drizzle";

interface MigrationHistoryRow {
  id: number;
  hash: string;
  created_at: string | number;
}

async function checkMigrations(): Promise<void> {
  const db = getDb();
  const fileMigrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  let lastAppliedMillis = -1;
  try {
    const historyResult = await db.execute(
      sql.raw(
        `select id, hash, created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at desc limit 1`,
      ),
    );
    const rows = (historyResult as unknown as { rows: MigrationHistoryRow[] }).rows;
    if (rows.length > 0) {
      lastAppliedMillis = Number(rows[0].created_at);
    }
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Migrations history table not found — treating all migrations as pending",
    );
  }

  const pending = fileMigrations.filter((migration) => migration.folderMillis > lastAppliedMillis);

  if (pending.length > 0) {
    logger.error(
      { pendingCount: pending.length, totalCount: fileMigrations.length },
      "Pending migrations detected — run `npm run migrate` to apply them",
    );
    process.exitCode = 1;
    return;
  }

  logger.info(
    { totalCount: fileMigrations.length },
    "No pending migrations — database schema is current",
  );
}

async function runMigrations(): Promise<void> {
  const db = getDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.info("Migrations completed successfully");
}

async function main(): Promise<void> {
  await hydrateSecretsIfConfigured();

  const checkOnly = process.argv.includes("--check");

  logger.info(
    checkOnly ? "Starting migration check (dry run)..." : "Starting database migrations...",
  );

  try {
    if (checkOnly) {
      await checkMigrations();
    } else {
      await runMigrations();
    }
  } catch (error) {
    logger.error({ error }, checkOnly ? "Migration check failed" : "Migration failed");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
