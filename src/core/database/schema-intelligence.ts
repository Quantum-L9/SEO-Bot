/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Schema
 *
 * The middle layer the bot was missing:
 *
 *   raw facts (serp_rankings, web_vitals, aeo_citations, ...)
 *     -> intelligence_signals        normalized observations
 *     -> intelligence_opportunities  ranked, grouped work
 *     -> intelligence_decisions      why the bot acted or did not
 *     -> intelligence_action_links   opportunity -> decision -> job -> outcome
 *     -> intelligence_experiments    measurement windows
 *     -> action_outcomes             existing feedback table
 *
 * WHY A DECISION LEDGER AND A LINK TABLE BOTH EXIST.
 * `action_outcomes` can record that something happened and how it went, but it
 * cannot say which opportunity caused it, which policy allowed it, or which
 * queued job carried it out. Without that chain the learning loop is broken:
 * you can see that rankings moved, but not what the bot did to move them, so
 * scoring can never improve. `intelligence_decisions` records the reasoning,
 * `intelligence_action_links` records the causal chain.
 *
 * A DEFERRAL IS A DECISION. The ledger records "considered and declined" with
 * its policy basis, not just successful actions. Otherwise "the gate blocked
 * this correctly" is indistinguishable from "the loop never looked at it".
 *
 * IDEMPOTENCY IS A SCHEMA CONCERN, NOT A HANDLER CONCERN.
 * BullMQ is at-least-once, so every handler here re-runs against state it has
 * already written. Rather than trusting each handler to check-then-insert (a
 * race under concurrent fan-out), the tables carry UNIQUE fingerprints the
 * writers upsert onto:
 *
 *   intelligence_signals        UNIQUE (client_id, fingerprint)
 *   intelligence_opportunities  UNIQUE (client_id, fingerprint)
 *   intelligence_action_links   UNIQUE (client_id, opportunity_id, job_name)
 *
 * Every table is client-scoped and every read path filters on client_id. The
 * portfolio benchmark is the single explicit exception and is aggregate-only.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { actionOutcomes, clients } from "./schema.js";
import { actionLog } from "./schema-extensions.js";

// ─── Intelligence Runs ───────────────────────────────────────────────────────

/**
 * One row per intelligence phase execution.
 *
 * `llmUsed` and `totalCost` are recorded per run so "this run spent money" is
 * answerable without joining llm_usage — the question an operator asks first
 * when a token bill moves.
 */
export const intelligenceRuns = pgTable(
  "intelligence_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    runType: varchar("run_type", { length: 80 }).notNull(),
    triggerSource: varchar("trigger_source", { length: 40 }).notNull().default("scheduler"),
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
    clientStartedIdx: index("idx_intel_runs_client_started").on(table.clientId, table.startedAt),
    statusIdx: index("idx_intel_runs_status").on(table.status),
  }),
);

// ─── Intelligence Signals ────────────────────────────────────────────────────

/**
 * A deterministic observation extracted from operational tables. Signals carry
 * no judgment beyond a rules-based severity and confidence — no LLM is involved
 * in producing one, so extraction is fully reproducible from the same rows.
 *
 * `suppressedUntil` lets an operator mute a signal that is real but not worth
 * acting on, without deleting the evidence that it fired.
 */
export const intelligenceSignals = pgTable(
  "intelligence_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => intelligenceRuns.id, { onDelete: "set null" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityKey: text("entity_key").notNull(),
    signalType: varchar("signal_type", { length: 80 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    /** 0..1 rules-derived confidence. Per-signal-type, never model-derived. */
    confidence: real("confidence").notNull().default(0),
    evidence: jsonb("evidence").notNull().default({}),
    /** Stable identity: md5(clientId:signalType:entityKey). */
    fingerprint: text("fingerprint").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("open"),
    suppressedUntil: timestamp("suppressed_until"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
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
 * (see opportunity-scorer) — deterministic and LLM-free by contract.
 */
export const intelligenceOpportunities = pgTable(
  "intelligence_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => intelligenceRuns.id, { onDelete: "set null" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    opportunityType: varchar("opportunity_type", { length: 80 }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    targetUrl: text("target_url"),
    targetKeyword: text("target_keyword"),
    /** sha256(clientId|opportunityType|sorted signal fingerprints). */
    fingerprint: text("fingerprint").notNull(),
    expectedImpact: real("expected_impact").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    urgency: real("urgency").notNull().default(0),
    effort: real("effort").notNull().default(0),
    risk: real("risk").notNull().default(0),
    score: real("score").notNull().default(0),
    status: varchar("status", { length: 40 }).notNull().default("open"),
    evidence: jsonb("evidence").notNull().default({}),
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

// ─── Intelligence Decisions ──────────────────────────────────────────────────

/**
 * Why the bot acted, or did not.
 *
 * `policyBasis` stores the gate's inputs verbatim — every flag and governor
 * value it consulted. That is what makes a past decision reconstructable months
 * later: "blocked" is not useful, "blocked because the circuit breaker was open
 * and score 41 was below the threshold of 50" is.
 */
export const intelligenceDecisions = pgTable(
  "intelligence_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => intelligenceRuns.id, { onDelete: "set null" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => intelligenceOpportunities.id, {
      onDelete: "set null",
    }),
    decisionType: varchar("decision_type", { length: 80 }).notNull(),
    /** act | defer | escalate | reject */
    decision: varchar("decision", { length: 40 }).notNull(),
    rationale: text("rationale").notNull(),
    policyBasis: jsonb("policy_basis").notNull().default({}),
    evidenceSummary: jsonb("evidence_summary").notNull().default({}),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    actionLogId: uuid("action_log_id").references(() => actionLog.id, { onDelete: "set null" }),
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

// ─── Intelligence Action Links ───────────────────────────────────────────────

/**
 * The causal chain: opportunity -> decision -> queued job / action_log -> outcome.
 *
 * The UNIQUE (client_id, opportunity_id, job_name) is the routing dedup —
 * re-routing the same opportunity to the same job is a no-op, which is what
 * keeps a BullMQ retry from sending outreach twice.
 */
export const intelligenceActionLinks = pgTable(
  "intelligence_action_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => intelligenceOpportunities.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id").references(() => intelligenceDecisions.id, {
      onDelete: "set null",
    }),
    actionLogId: uuid("action_log_id").references(() => actionLog.id, { onDelete: "set null" }),
    /** Downstream BullMQ job this opportunity routed to, when it routed to one. */
    jobName: varchar("job_name", { length: 100 }),
    /** Deterministic BullMQ job id used for the enqueue (dedup key). */
    jobId: text("job_id"),
    actionOutcomeId: uuid("action_outcome_id").references(() => actionOutcomes.id, {
      onDelete: "set null",
    }),
    /** The intelligence action vocabulary entry that was proposed. */
    action: varchar("action", { length: 100 }).notNull(),
    status: varchar("status", { length: 40 }).notNull().default("queued"),
    blockedReason: text("blocked_reason"),
    metadata: jsonb("metadata").notNull().default({}),
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

// ─── Intelligence Experiments ────────────────────────────────────────────────

/**
 * An explicit measurement window for one action.
 *
 * SEO effects are slow and noisy, so attribution needs a stated baseline and a
 * stated measurement period fixed BEFORE the result is known. Recording the
 * window up front is what stops the loop from picking whichever window makes an
 * action look good after the fact.
 */
export const intelligenceExperiments = pgTable(
  "intelligence_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").references(() => intelligenceOpportunities.id, {
      onDelete: "set null",
    }),
    actionOutcomeId: uuid("action_outcome_id").references(() => actionOutcomes.id, {
      onDelete: "set null",
    }),
    hypothesis: text("hypothesis").notNull(),
    targetMetric: varchar("target_metric", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityKey: text("entity_key").notNull(),
    baselineStart: timestamp("baseline_start").notNull(),
    baselineEnd: timestamp("baseline_end").notNull(),
    measurementStart: timestamp("measurement_start").notNull(),
    measurementEnd: timestamp("measurement_end").notNull(),
    status: varchar("status", { length: 40 }).notNull().default("measuring"),
    result: jsonb("result").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clientStatusIdx: index("idx_intel_experiments_client_status").on(table.clientId, table.status),
    measurementEndIdx: index("idx_intel_experiments_measure_end").on(table.measurementEnd),
  }),
);
