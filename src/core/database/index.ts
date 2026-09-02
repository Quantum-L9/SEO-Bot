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
import * as reportingSchema from "./schema-reporting.js";

const logger = createModuleLogger("database");

// FIX(review): guard against silent key overwrites when merging the schema modules.
// Every module is checked against every earlier one, so adding a fourth module
// cannot reintroduce the silent-overwrite bug this guard exists to prevent.
const _schemaModules: ReadonlyArray<{ name: string; exports: Record<string, unknown> }> = [
  { name: "schema.ts", exports: baseSchema },
  { name: "schema-extensions.ts", exports: extSchema },
  { name: "schema-reporting.ts", exports: reportingSchema },
  { name: "schema-intelligence.ts", exports: intelSchema },
];

for (let i = 1; i < _schemaModules.length; i += 1) {
  const current = _schemaModules[i];
  for (let j = 0; j < i; j += 1) {
    const earlier = _schemaModules[j];
    const collisions = Object.keys(current.exports).filter((key) =>
      Object.hasOwn(earlier.exports, key),
    );
    if (collisions.length > 0) {
      throw new Error(
        `Duplicate database schema keys detected between ${earlier.name} and ${current.name}: ` +
          `${collisions.join(", ")}. Rename the conflicting export in ${current.name}.`,
      );
    }
  }
}

/** Unified schema namespace — base tables + extensions + reporting + intelligence */
export const schema = {
  ...baseSchema,
  ...extSchema,
  ...reportingSchema,
  ...intelSchema,
} as const;

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
