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

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config.js";
import { createModuleLogger } from "../logger.js";
import * as baseSchema from "./schema.js";
import * as extSchema from "./schema-extensions.js";
import * as intelSchema from "./schema-intelligence.js";

const logger = createModuleLogger("database");

// FIX(review): guard against silent key overwrites when merging base + extension schemas.
// Extended for the intelligence schema: the merge is now three-way, so the guard
// must compare every pair — checking only base-vs-extensions would let an
// intelligence export silently shadow a base or extension table.
const _schemaSources: Array<{ name: string; module: Record<string, unknown> }> = [
  { name: "schema.ts", module: baseSchema },
  { name: "schema-extensions.ts", module: extSchema },
  { name: "schema-intelligence.ts", module: intelSchema },
];

for (let i = 0; i < _schemaSources.length; i++) {
  for (let j = i + 1; j < _schemaSources.length; j++) {
    const left = _schemaSources[i];
    const right = _schemaSources[j];
    const duplicateKeys = Object.keys(left.module).filter((key) =>
      Object.hasOwn(right.module, key),
    );
    if (duplicateKeys.length > 0) {
      throw new Error(
        `Duplicate database schema keys detected between ${left.name} and ${right.name}: ` +
          `${duplicateKeys.join(", ")}. Rename the conflicting export in ${right.name}.`,
      );
    }
  }
}

/** Unified schema namespace — base tables + extensions + intelligence */
export const schema = { ...baseSchema, ...extSchema, ...intelSchema } as const;

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

  _pool.on("error", (err) => {
    logger.error({ err }, "Unexpected database pool error");
  });

  _db = drizzle(_pool, { schema });
  logger.info("Database connection pool initialized");
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    logger.info("Database connection pool closed");
  }
}
