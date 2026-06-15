/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Database Migration Runner
 * Run with: pnpm migrate
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, closeDb } from './index.js';
import { createModuleLogger } from '../logger.js';

const logger = createModuleLogger('migrate');

async function runMigrations() {
  logger.info('Starting database migrations...');

  try {
    const db = getDb();
    await migrate(db, { migrationsFolder: './drizzle' });
    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  } finally {
    await closeDb();
  }
}

runMigrations();
