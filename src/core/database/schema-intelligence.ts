/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Plane Schema (ADR-0016)
 *
 * Operational tables record FACTS (rankings, vitals, citations, jobs).
 * These tables record INTERPRETATION:
 *
 *   runs          — one durable record per autonomous reasoning cycle
 *   signals       — normalized machine-readable observations (never actions)
 *   opportunities — signals grouped into scored, rankable work
 *   decisions     — what the bot chose, and the policy basis for choosing it
 *   experiments   — baseline/measurement windows for attribution
 *   policyState   — the autonomous governors as SQL-readable state
 *
 * Nothing here mutates a client site. Execution remains with the existing
 * modules, the BullMQ scheduler, and the execution-policy approval flow.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { actionOutcomes, clients } from "./schema.js";

// ─── Runs ─────────────────────────────────────────────────────────────────────

export const intelligenceRuns = pgTable(
  "intelligence_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for portfolio-wide runs that are not scoped to one tenant. */
    clientId: uuid("client_id").references(() => clients.id),
    runType: varchar("run_type", { length: 80 }).notNull(),
    triggerSource: varchar("trigger_source", { length: 40 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("running"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    durationMs: integer("duration_ms"),
    llmUsed: boolean("llm_used").notNull().default(false),
    totalCost: numeric("total_cost", { precision: 12, scale: 6 }).default("0"),
    error: text("error"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => ({
    typeStartedIdx: index("idx_intel_runs_type_started").on(table.runType, table.startedAt),
    clientStartedIdx: index("idx_intel_runs_client_started").on(table.clientId, table.startedAt),
  }),
);

// ─── Signals ──────────────────────────────────────────────────────────────────

/**
 * A signal is an OBSERVATION, not an action.
 *
 * `fingerprint` is the stable identity of "this observation about this entity".
 * The UNIQUE (run_id, fingerprint) index is what makes a retried run idempotent:
 * BullMQ is at-least-once, so the same reasoning cycle can execute twice and
 * must not double-record. (A UNIQUE index on observed_at would not dedupe
 * anything, since observed_at defaults to now().) The separate
 * (client_id, fingerprint, observed_at DESC) index serves suppression lookups.
 */
export const intelligenceSignals = pgTable(
  "intelligence_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => intelligenceRuns.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: text("entity_id"),
    signalType: varchar("signal_type", { length: 80 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
    evidence: jsonb("evidence").notNull().default({}),
    fingerprint: text("fingerprint").notNull(),
    suppressedUntil: timestamp("suppressed_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runFingerprintIdx: uniqueIndex("idx_intel_signals_run_fingerprint").on(
      table.runId,
      table.fingerprint,
    ),
    clientFingerprintIdx: index("idx_intel_signals_client_fingerprint").on(
      table.clientId,
      table.fingerprint,
      table.observedAt,
    ),
    clientTypeIdx: index("idx_intel_signals_client_type").on(
      table.clientId,
      table.signalType,
      table.observedAt,
    ),
  }),
);

// ─── Opportunities ────────────────────────────────────────────────────────────

export const intelligenceOpportunities = pgTable(
  "intelligence_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => intelligenceRuns.id, { onDelete: "set null" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityType: varchar("opportunity_type", { length: 80 }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    targetUrl: text("target_url"),
    targetKeyword: text("target_keyword"),
    expectedImpact: numeric("expected_impact", { precision: 8, scale: 4 }),
    effort: numeric("effort", { precision: 8, scale: 4 }),
    risk: numeric("risk", { precision: 8, scale: 4 }),
    urgency: numeric("urgency", { precision: 8, scale: 4 }),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    score: numeric("score", { precision: 10, scale: 4 }).notNull(),
    status: varchar("status", { length: 40 }).notNull().default("open"),
    fingerprint: text("fingerprint").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    runFingerprintIdx: uniqueIndex("idx_intel_opportunities_run_fingerprint").on(
      table.runId,
      table.fingerprint,
    ),
    clientStatusIdx: index("idx_intel_opportunities_client_status").on(
      table.clientId,
      table.status,
      table.score,
    ),
  }),
);

// ─── Decisions ────────────────────────────────────────────────────────────────

export const intelligenceDecisions = pgTable(
  "intelligence_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => intelligenceRuns.id, { onDelete: "set null" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityId: uuid("opportunity_id").references(() => intelligenceOpportunities.id, {
      onDelete: "set null",
    }),
    decisionType: varchar("decision_type", { length: 80 }).notNull(),
    /** propose_action | defer_budget | suppress_duplicate | escalate_to_operator | run_diagnostic | no_action */
    decision: varchar("decision", { length: 40 }).notNull(),
    rationale: text("rationale").notNull(),
    policyBasis: jsonb("policy_basis").notNull().default({}),
    evidenceSummary: jsonb("evidence_summary").notNull().default({}),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    /** FK-free by design: action_log rows may be pruned independently. */
    actionLogId: uuid("action_log_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clientCreatedIdx: index("idx_intel_decisions_client_created").on(
      table.clientId,
      table.createdAt,
    ),
    opportunityIdx: index("idx_intel_decisions_opportunity").on(table.opportunityId),
  }),
);

// ─── Experiments (attribution windows) ────────────────────────────────────────

export const intelligenceExperiments = pgTable(
  "intelligence_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    actionOutcomeId: uuid("action_outcome_id").references(() => actionOutcomes.id, {
      onDelete: "set null",
    }),
    decisionId: uuid("decision_id").references(() => intelligenceDecisions.id, {
      onDelete: "set null",
    }),
    hypothesis: text("hypothesis").notNull(),
    targetMetric: varchar("target_metric", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: text("entity_id").notNull(),
    baselineStart: timestamp("baseline_start").notNull(),
    baselineEnd: timestamp("baseline_end").notNull(),
    measurementStart: timestamp("measurement_start").notNull(),
    measurementEnd: timestamp("measurement_end").notNull(),
    status: varchar("status", { length: 40 }).notNull().default("measuring"),
    result: jsonb("result").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    statusWindowIdx: index("idx_intel_experiments_status_window").on(
      table.status,
      table.measurementEnd,
    ),
    clientIdx: index("idx_intel_experiments_client").on(table.clientId, table.createdAt),
  }),
);

// ─── Policy state ─────────────────────────────────────────────────────────────

export const intelligencePolicyState = pgTable("intelligence_policy_state", {
  clientId: uuid("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  autonomousActionsPaused: boolean("autonomous_actions_paused").notNull().default(false),
  pauseReason: text("pause_reason"),
  dailyLlmBudgetRemaining: numeric("daily_llm_budget_remaining", { precision: 12, scale: 6 }),
  outreachCapacityRemaining: integer("outreach_capacity_remaining"),
  rankingCircuitOpen: boolean("ranking_circuit_open").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
