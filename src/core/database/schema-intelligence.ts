/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Schema
 *
 * Tables for the intelligence control loop: runs (observability), signals
 * (deterministic observations), opportunities (scored clusters of signals), and
 * action links (the join between an opportunity and what it actually caused).
 *
 * IDEMPOTENCY IS A SCHEMA CONCERN, NOT A HANDLER CONCERN.
 * BullMQ is at-least-once: every handler here can be re-run against state it
 * already wrote. Rather than trusting each handler to check-then-insert (a race
 * under concurrent fan-out), each table carries a UNIQUE fingerprint the writer
 * upserts onto. A retry updates the same row; it never creates a second one.
 *
 *   intelligence_signals        UNIQUE (client_id, fingerprint)
 *   intelligence_opportunities  UNIQUE (client_id, fingerprint)
 *   intelligence_action_links   UNIQUE (client_id, opportunity_id, job_name)
 *
 * Every table is client-scoped and every read path filters on client_id — the
 * portfolio surface is the single explicit exception and is anonymized.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./schema.js";

// ─── Intelligence Runs ───────────────────────────────────────────────────────

/**
 * One row per intelligence phase execution (extract / score / plan / attribute).
 * `mode` records the INTELLIGENCE_MODE the run executed under, so a later audit
 * can tell "no actions were routed" (correct for observe) apart from "actions
 * should have been routed and weren't" (a defect).
 */
export const intelligenceRuns = pgTable(
  "intelligence_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    runType: varchar("run_type", { length: 40 }).notNull(),
    mode: varchar("mode", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    error: text("error"),
    stats: jsonb("stats").notNull().default({}),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    clientStartedIdx: index("idx_intel_runs_client_started").on(table.clientId, table.startedAt),
    statusIdx: index("idx_intel_runs_status").on(table.status),
  }),
);

// ─── Intelligence Signals ────────────────────────────────────────────────────

/**
 * A deterministic observation extracted from operational tables. Signals carry
 * NO judgment beyond a rules-based severity — no LLM is involved in producing
 * one, so extraction is fully reproducible from the same input rows.
 */
export const intelligenceSignals = pgTable(
  "intelligence_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    signalType: varchar("signal_type", { length: 50 }).notNull(),
    /** Stable identity of the observation: sha256(clientId|signalType|entityKey). */
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    /** Human-readable subject of the signal (keyword, url, platform, prospect). */
    entityKey: varchar("entity_key", { length: 500 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    /** Rules-derived 0..1 strength used by the scorer. No LLM input. */
    strength: real("strength").notNull().default(0),
    evidence: jsonb("evidence").notNull().default({}),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (table) => ({
    clientFingerprintUniq: unique("uniq_intel_signal_client_fingerprint").on(
      table.clientId,
      table.fingerprint,
    ),
    clientTypeIdx: index("idx_intel_signals_client_type").on(table.clientId, table.signalType),
    observedAtIdx: index("idx_intel_signals_observed").on(table.observedAt),
  }),
);

// ─── Intelligence Opportunities ──────────────────────────────────────────────

/**
 * A scored cluster of signals. Scoring is a pure function of the signal inputs
 * (see opportunity-scorer.ts) — deterministic and LLM-free by contract, so the
 * same fixtures always produce the same score.
 */
export const intelligenceOpportunities = pgTable(
  "intelligence_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityType: varchar("opportunity_type", { length: 50 }).notNull(),
    /** sha256(clientId|opportunityType|sorted signal fingerprints). */
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    score: real("score").notNull().default(0),
    impact: real("impact").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    effort: real("effort").notNull().default(0),
    risk: real("risk").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    /** Signal fingerprints that produced this opportunity (audit trail). */
    signalFingerprints: jsonb("signal_fingerprints").notNull().default([]),
    rationale: text("rationale"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    clientFingerprintUniq: unique("uniq_intel_opp_client_fingerprint").on(
      table.clientId,
      table.fingerprint,
    ),
    clientScoreIdx: index("idx_intel_opps_client_score").on(table.clientId, table.score),
    clientStatusIdx: index("idx_intel_opps_client_status").on(table.clientId, table.status),
  }),
);

// ─── Intelligence Action Links ───────────────────────────────────────────────

/**
 * The join between an opportunity and what it caused: an action_log proposal
 * and/or a queued downstream job. The UNIQUE (client_id, opportunity_id,
 * job_name) is the routing dedup — re-routing the same opportunity to the same
 * job is a no-op, which is what keeps a BullMQ retry from sending outreach twice.
 */
export const intelligenceActionLinks = pgTable(
  "intelligence_action_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => intelligenceOpportunities.id),
    /** Downstream BullMQ job this opportunity routed to, when it routed to one. */
    jobName: varchar("job_name", { length: 100 }),
    /** Deterministic BullMQ job id used for the enqueue (dedup key). */
    jobId: varchar("job_id", { length: 200 }),
    /** action_log row this opportunity produced, when it produced one. */
    actionLogId: uuid("action_log_id"),
    /** The intelligence action vocabulary entry that was proposed. */
    action: varchar("action", { length: 100 }).notNull(),
    outcome: varchar("outcome", { length: 30 }).notNull().default("proposed"),
    blockedReason: text("blocked_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clientOppJobUniq: unique("uniq_intel_link_client_opp_job").on(
      table.clientId,
      table.opportunityId,
      table.jobName,
    ),
    clientOppIdx: index("idx_intel_links_client_opp").on(table.clientId, table.opportunityId),
  }),
);
