/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * Test harness for the intelligence loop.
 *
 * These suites run against REAL PostgreSQL, in-process, via PGlite. That is a
 * deliberate choice over mocking the drizzle query builder.
 *
 * The properties under test here are properties of SQL, not of TypeScript:
 * whether `ON CONFLICT (client_id, fingerprint) DO UPDATE` actually collapses a
 * retry onto one row, whether a UNIQUE index actually refuses a second routing
 * claim, and whether a `WHERE client_id = $1` actually excludes another tenant.
 * A mocked query builder answers all three by construction — it would return
 * whatever the mock was told to return, and would keep passing after someone
 * deleted the WHERE clause. Running the real engine means the tenant-isolation
 * and idempotency assertions can fail, which is the only reason to write them.
 *
 * BullMQ/Redis is NOT faked into existence here: the router takes a JobSink, so
 * job routing is asserted against a recording fake, exactly as the acceptance
 * brief prescribes for unit tests. Queue behaviour under a live Redis is an
 * operator-run stage — see docs/INTELLIGENCE_TESTING.md.
 */

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { vi } from "vitest";
import * as baseSchema from "../../../src/core/database/schema.js";
import * as extSchema from "../../../src/core/database/schema-extensions.js";
import type { JobSink } from "../../../src/modules/intelligence/types.js";

export const schema = { ...baseSchema, ...extSchema } as const;

export type TestDb = ReturnType<typeof drizzle>;

/** The migrations that must be applied, in order, for the loop to work. */
const MIGRATIONS = [
  "drizzle/0000_steady_morlun.sql",
  "drizzle/0001_build_intelligence_artifacts.sql",
  "drizzle/0002_intelligence_control_loop.sql",
  "drizzle/0003_action_outcomes_memory_columns.sql",
];

/**
 * Bring up an empty database and apply the real migration files.
 *
 * Applying the shipped SQL rather than pushing the drizzle schema is the point:
 * it proves the migration an operator will run produces a database these
 * queries work against. A schema-push harness would pass even if
 * 0002_intelligence_control_loop.sql were empty.
 */
export async function createTestDb(): Promise<{ db: TestDb; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client);

  for (const path of MIGRATIONS) {
    const sqlText = readFileSync(path, "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      // PGlite does not ship the pgcrypto extension. 0000 creates it, but the
      // only thing these tables need from it is `gen_random_uuid()`, which has
      // been core PostgreSQL since 13 — so skipping the CREATE EXTENSION is a
      // limitation of the test engine, not a divergence from the schema under
      // test. Every other statement is applied verbatim.
      if (/^create\s+extension/i.test(trimmed)) continue;
      await client.exec(trimmed);
    }
  }

  return { db, client };
}

/**
 * Tables the suites write to, in dependency order (children before parents).
 *
 * Truncating between tests rather than rebuilding the database keeps a suite
 * to one PGlite boot instead of one per test — the difference between a couple
 * of seconds and well over a minute, which is the difference between a check
 * developers run and one they skip.
 */
const TRUNCATABLE_TABLES = [
  "intelligence_action_links",
  "intelligence_decisions",
  "intelligence_opportunities",
  "intelligence_signals",
  "intelligence_runs",
  "action_log",
  "action_outcomes",
  "serp_rankings",
  "competitor_snapshots",
  "web_vitals",
  "aeo_citations",
  "page_engagement",
  "link_prospects",
  "llm_usage",
  "clients",
];

/** Empty every table the loop touches, leaving the schema in place. */
export async function resetTables(client: PGlite): Promise<void> {
  await client.exec(`TRUNCATE ${TRUNCATABLE_TABLES.join(", ")} RESTART IDENTITY CASCADE;`);
}

export interface SeedClientOptions {
  name?: string;
  domain: string;
  industry?: string;
  active?: boolean;
  config?: Record<string, unknown>;
  posthogApiKey?: string;
}

/** Insert a tenant and return its id. */
export async function seedClient(db: TestDb, options: SeedClientOptions): Promise<string> {
  const [row] = await db
    .insert(schema.clients)
    .values({
      name: options.name ?? options.domain,
      domain: options.domain,
      industry: options.industry ?? "roofing",
      active: options.active ?? true,
      config: options.config ?? {},
      posthogApiKey: options.posthogApiKey ?? null,
    })
    .returning({ id: schema.clients.id });
  return row.id;
}

/**
 * A scheduler stand-in that records what it was asked to enqueue.
 *
 * It also enforces BullMQ's actual deduplication rule — an add whose `jobId`
 * already exists is ignored — because that rule is half of the loop's
 * idempotency story and a fake that silently accepted duplicates would let a
 * double-routing bug pass.
 */
export class FakeJobSink implements JobSink {
  readonly calls: Array<{ jobName: string; data: Record<string, unknown>; jobId?: string }> = [];
  private readonly seenJobIds = new Set<string>();

  addJob = vi.fn(
    async (
      jobName: string,
      data: Record<string, unknown>,
      opts: { jobId?: string } = {},
    ): Promise<void> => {
      if (opts.jobId && this.seenJobIds.has(opts.jobId)) return;
      if (opts.jobId) this.seenJobIds.add(opts.jobId);
      this.calls.push({ jobName, data, jobId: opts.jobId });
    },
  );

  get jobNames(): string[] {
    return this.calls.map((call) => call.jobName);
  }

  reset(): void {
    this.calls.length = 0;
    this.seenJobIds.clear();
    this.addJob.mockClear();
  }
}

/** The env shape the loop reads. Every field defaults to the safest value. */
export interface ModeOptions {
  INTELLIGENCE_MODE?: string;
  INTELLIGENCE_LLM_PLANNING_ENABLED?: boolean;
  INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING?: boolean;
  INTELLIGENCE_ALLOW_OUTREACH_ROUTING?: boolean;
  INTELLIGENCE_ALLOW_SITE_MUTATION?: boolean;
  INTELLIGENCE_PORTFOLIO_BENCHMARK?: boolean;
  INTELLIGENCE_SIGNAL_TTL_HOURS?: number;
  DAILY_SPEND_CAP?: number;
}

/**
 * Build the config object the modules see.
 *
 * Defaults mirror an unconfigured deployment — mode off, every flag false —
 * so a test that forgets to enable something sees the production-safe answer
 * rather than an accidentally permissive one.
 */
export function makeConfig(options: ModeOptions = {}): Record<string, unknown> {
  return {
    INTELLIGENCE_MODE: options.INTELLIGENCE_MODE ?? "off",
    INTELLIGENCE_LLM_PLANNING_ENABLED: options.INTELLIGENCE_LLM_PLANNING_ENABLED ?? false,
    INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: options.INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING ?? false,
    INTELLIGENCE_ALLOW_OUTREACH_ROUTING: options.INTELLIGENCE_ALLOW_OUTREACH_ROUTING ?? false,
    INTELLIGENCE_ALLOW_SITE_MUTATION: options.INTELLIGENCE_ALLOW_SITE_MUTATION ?? false,
    INTELLIGENCE_PORTFOLIO_BENCHMARK: options.INTELLIGENCE_PORTFOLIO_BENCHMARK ?? false,
    INTELLIGENCE_SIGNAL_TTL_HOURS: options.INTELLIGENCE_SIGNAL_TTL_HOURS ?? 72,
    DAILY_SPEND_CAP: options.DAILY_SPEND_CAP,
  };
}

export const silentLogger = {
  createModuleLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
};
