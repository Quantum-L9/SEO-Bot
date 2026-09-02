/* L9_META
 * layer: test
 * role: live_service_harness
 * status: active
 */

/**
 * Reachability, seeding and teardown for the gate-5 suite.
 *
 * Everything else in `tests/` runs against fakes. The fakes are built to
 * reproduce the properties the assertions depend on — at-least-once delivery,
 * `ON CONFLICT DO NOTHING` returning nothing, a fresh row getting a fresh id —
 * and one of them did not, which is how a test that passed against a broken
 * dedup key was caught. That is the standing risk with fakes, and it is not
 * closed by writing more of them. This harness is what lets the same assertions
 * run against the real thing.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "ioredis";
import pg from "pg";

/** CI sets this. A skip nobody notices is how a gap stops being tracked. */
const REQUIRED = process.env.LIVE_SERVICES_REQUIRED === "1";

export const DATABASE_URL = process.env.DATABASE_URL ?? "";
export const REDIS_URL = process.env.REDIS_URL ?? "";

let cachedReason: string | null | undefined;

async function probe(): Promise<string | null> {
  if (!DATABASE_URL) return "DATABASE_URL is not set";
  if (!REDIS_URL) return "REDIS_URL is not set";

  const pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("select 1");
  } catch (error) {
    return `Postgres unreachable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await pool.end();
  }

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch (error) {
    return `Redis unreachable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    redis.disconnect();
  }
  return null;
}

/**
 * `null` when both services answered. A string reason otherwise — unless
 * `LIVE_SERVICES_REQUIRED=1`, where an absent service is a failure rather than
 * a reason, because the whole point of gate 5 is that it ran.
 */
export async function liveServicesUnavailable(): Promise<string | null> {
  if (cachedReason === undefined) {
    cachedReason = await probe();
    if (cachedReason !== null) {
      const message = `gate 5 (live services): ${cachedReason}`;
      if (REQUIRED) throw new Error(`${message} — LIVE_SERVICES_REQUIRED=1`);
      console.warn(
        `\n${message}\n` +
          "  Skipping. Start them with:\n" +
          "    docker compose -f docker-compose.validation.yml up -d\n" +
          "  and export DATABASE_URL / REDIS_URL. Set LIVE_SERVICES_REQUIRED=1 to make\n" +
          "  this a failure instead of a skip.\n",
      );
    }
  }
  return cachedReason;
}

export function connect() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  return { pool, db: drizzle(pool) };
}

export function redisClient(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * A tenant, with everything the reporting views need to see it.
 *
 * Returns the id rather than taking one, so two calls in one test are two
 * genuinely distinct tenants — the tenancy assertions are worthless if both
 * sides are the same row.
 */
export async function seedClient(
  db: ReturnType<typeof connect>["db"],
  name: string,
): Promise<string> {
  const rows = await db.execute(sql`
    INSERT INTO clients (name, domain, industry, active)
    VALUES (${name}, ${`${name}.example`}, 'roofing', true)
    RETURNING id
  `);
  const id = (rows as unknown as { rows: { id: string }[] }).rows[0]?.id;
  if (!id) throw new Error(`seedClient(${name}) returned no id`);
  return id;
}

/**
 * Delete only what a test seeded, by client id.
 *
 * Not a truncate: this suite must be safe to point at a shared staging database
 * — gate 5 is defined as the gate that runs against staging and production —
 * and a truncate there is not a test failure, it is an outage.
 */
export async function dropClient(
  db: ReturnType<typeof connect>["db"],
  clientId: string,
): Promise<void> {
  await db.execute(sql`DELETE FROM intelligence_runs WHERE client_id = ${clientId}::uuid`);
  await db.execute(sql`DELETE FROM aeo_citations WHERE client_id = ${clientId}::uuid`);
  await db.execute(sql`DELETE FROM serp_rankings WHERE client_id = ${clientId}::uuid`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}::uuid`);
}
