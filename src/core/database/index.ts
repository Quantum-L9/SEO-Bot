/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Database Connection
 * Drizzle ORM with PostgreSQL. Connection pooling via pg.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config.js';
import { createModuleLogger } from '../logger.js';
import * as baseSchema from './schema.js';
import * as extSchema from './schema-extensions.js';

const logger = createModuleLogger('database');

/** Unified schema namespace — includes base tables + extensions */
export const schema = { ...baseSchema, ...extSchema } as const;

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: pg.Pool | null = null;

export function getDb() {
  if (_db) return _db;

  const config = getConfig();

  _pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  _pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  _db = drizzle(_pool, { schema });
  logger.info('Database connection pool initialized');
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    logger.info('Database connection pool closed');
  }
}
