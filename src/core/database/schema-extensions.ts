/* L9_META
 * layer: core
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Database Schema Extensions (v1.3)
 *
 * New tables for:
 * - Action log with execution policy tracking
 * - Approval queue with multiple-choice options
 * - Behavior insight recommendations
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./schema.js";

// ─── Action Log (Execution Policy) ─────────────────────────────────────────────

export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    module: varchar("module", { length: 50 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    description: text("description").notNull(),
    rationale: text("rationale").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    riskLevel: varchar("risk_level", { length: 20 }).notNull(),
    reversible: boolean("reversible").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending_approval"),
    // For multiple-choice approvals
    options: jsonb("options"), // JSON array of ActionOption[]
    aiRecommendation: text("ai_recommendation"),
    aiConfidence: real("ai_confidence"),
    // Approval tracking
    approvedBy: varchar("approved_by", { length: 255 }),
    approvedAt: timestamp("approved_at"),
    selectedOption: varchar("selected_option", { length: 50 }),
    rejectionReason: text("rejection_reason"),
    // Execution tracking
    executedAt: timestamp("executed_at"),
    executionResult: text("execution_result"),
    estimatedImpact: varchar("estimated_impact", { length: 20 }),
    resolvedAt: timestamp("resolved_at"), // when an action was approved/rejected
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"), // auto-expire pending approvals after 7 days
  },
  (table) => ({
    clientStatusIdx: index("idx_action_log_client_status").on(table.clientId, table.status),
    createdAtIdx: index("idx_action_log_created").on(table.createdAt),
  }),
);

// ─── Behavior Recommendations ───────────────────────────────────────────────────

export const behaviorRecommendations = pgTable(
  "behavior_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    insight: text("insight").notNull(),
    severity: varchar("severity", { length: 20 }).notNull(), // info, warning, critical
    pagePath: varchar("page_path", { length: 500 }),
    metric: varchar("metric", { length: 50 }), // bounce_rate, time_on_page, scroll_depth, etc.
    currentValue: real("current_value"),
    benchmarkValue: real("benchmark_value"),
    // Multiple choice options
    options: jsonb("options").notNull(), // Array of { id, label, description, risk, recommended, confidence }
    aiRecommendedOption: varchar("ai_recommended_option", { length: 50 }),
    aiRationale: text("ai_rationale"),
    // Resolution
    selectedOption: varchar("selected_option", { length: 50 }),
    resolvedBy: varchar("resolved_by", { length: 50 }), // 'auto' | 'operator'
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    weekOf: varchar("week_of", { length: 10 }).notNull(), // YYYY-WW format
  },
  (table) => ({
    clientWeekIdx: index("idx_behavior_rec_client_week").on(table.clientId, table.weekOf),
  }),
);

// ─── Autonomy Runtime Controls (ADR-0008) ───────────────────────────────────────

export const agentJobs = pgTable(
  "agent_jobs",
  {
    jobId: uuid("job_id").primaryKey().defaultRandom(),
    repo: varchar("repo", { length: 100 }).notNull().default("seo-bot"),
    clientId: varchar("client_id", { length: 255 }),
    triggerType: varchar("trigger_type", { length: 50 }).notNull(),
    triggerPayload: jsonb("trigger_payload"),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    assignedWorker: varchar("assigned_worker", { length: 100 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    costCapUsd: numeric("cost_cap_usd", { precision: 10, scale: 6 }).notNull().default("2.00"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    errorMessage: text("error_message"),
    resultArtifact: jsonb("result_artifact"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).unique(),
  },
  (table) => ({
    statusCreatedIdx: index("idx_seo_agent_jobs_status_created").on(table.status, table.createdAt),
    clientIdIdx: index("idx_seo_agent_jobs_client_id").on(table.clientId, table.createdAt),
  }),
);

export const budgetViolations = pgTable("budget_violations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => agentJobs.jobId),
  repo: varchar("repo", { length: 100 }).notNull().default("seo-bot"),
  clientId: varchar("client_id", { length: 255 }),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull(),
  costCapUsd: numeric("cost_cap_usd", { precision: 10, scale: 6 }).notNull(),
  overageUsd: numeric("overage_usd", { precision: 10, scale: 6 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const compensationLog = pgTable("compensation_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: uuid("job_id"),
  clientId: varchar("client_id", { length: 255 }),
  stepId: varchar("step_id", { length: 255 }).notNull(),
  actionType: varchar("action_type", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  errorMessage: text("error_message"),
  compensatedAt: timestamp("compensated_at").notNull().defaultNow(),
});

// ─── Build-Intelligence Artifacts (l9.website-intelligence seam) ─────────────────
// Single content-addressed store for the three sealed build-time artifacts
// (CompetitiveLandscape, SEOContentBlueprint, StructuredContentPackage). The
// artifact_id is `${artifact_type}:${payload_digest}` and is globally unique;
// re-sealing identical content is idempotent, and an artifact is NEVER
// overwritten with a different digest (fail-closed lineage).

// ─── Intelligence Control Loop (INTEL) ──────────────────────────────────────────
// The intelligence module observes, scores, and routes. Every row here is
// client-scoped by construction: a query that forgets `client_id` is a
// cross-tenant leak, so the indexes below all lead with it.
//
// Idempotency is carried by `fingerprint`, not by row identity. BullMQ is
// at-least-once: a retried extract MUST update the same signal row rather than
// insert a second one, so (client_id, fingerprint) is UNIQUE and writes are
// upserts keyed on that pair.

export const intelligenceRuns = pgTable(
  "intelligence_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    // extract_signals | score_opportunities | plan_actions | attribute_outcomes
    runType: varchar("run_type", { length: 40 }).notNull(),
    // The INTELLIGENCE_MODE in force when this run executed. Recorded so an
    // audit can prove a routed job was legal for the mode it ran under.
    mode: varchar("mode", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    error: text("error"),
    signalsWritten: integer("signals_written").notNull().default(0),
    opportunitiesWritten: integer("opportunities_written").notNull().default(0),
    decisionsWritten: integer("decisions_written").notNull().default(0),
    jobsRouted: integer("jobs_routed").notNull().default(0),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    clientTypeIdx: index("idx_intel_runs_client_type").on(table.clientId, table.runType),
    startedAtIdx: index("idx_intel_runs_started").on(table.startedAt),
  }),
);

export const intelligenceSignals = pgTable(
  "intelligence_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    runId: uuid("run_id"),
    // keyword_drop | bad_lcp_high_exit | citation_loss | prospect_ready
    signalType: varchar("signal_type", { length: 50 }).notNull(),
    // Deterministic over (clientId, signalType, subject) — the idempotency key.
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    // Keyword, page path, or platform this signal is about. Never a raw URL
    // with query parameters — see redactSubject in the extractor.
    subject: varchar("subject", { length: 500 }).notNull(),
    // Numeric evidence only (positions, metrics, thresholds). No source
    // content, no secrets, no absolute paths.
    evidence: jsonb("evidence").notNull().default({}),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    firstObservedAt: timestamp("first_observed_at").notNull().defaultNow(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (table) => ({
    clientFingerprintIdx: uniqueIndex("uq_intel_signals_client_fingerprint").on(
      table.clientId,
      table.fingerprint,
    ),
    clientTypeIdx: index("idx_intel_signals_client_type").on(table.clientId, table.signalType),
    clientStatusIdx: index("idx_intel_signals_client_status").on(table.clientId, table.status),
  }),
);

export const intelligenceOpportunities = pgTable(
  "intelligence_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityType: varchar("opportunity_type", { length: 50 }).notNull(),
    // Deterministic over the clustered signal fingerprints — re-scoring the
    // same signal group updates one row instead of opening a duplicate.
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    score: real("score").notNull(),
    impact: real("impact").notNull(),
    confidence: real("confidence").notNull(),
    effort: real("effort").notNull(),
    risk: real("risk").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    signalFingerprints: jsonb("signal_fingerprints").notNull().default([]),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    clientFingerprintIdx: uniqueIndex("uq_intel_opps_client_fingerprint").on(
      table.clientId,
      table.fingerprint,
    ),
    clientScoreIdx: index("idx_intel_opps_client_score").on(table.clientId, table.score),
    clientStatusIdx: index("idx_intel_opps_client_status").on(table.clientId, table.status),
  }),
);

export const intelligenceDecisions = pgTable(
  "intelligence_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    runId: uuid("run_id"),
    opportunityId: uuid("opportunity_id"),
    mode: varchar("mode", { length: 20 }).notNull(),
    // deterministic | llm — which planner produced the proposed action.
    source: varchar("source", { length: 20 }).notNull(),
    proposedAction: varchar("proposed_action", { length: 100 }).notNull(),
    // routed | proposed | blocked
    decision: varchar("decision", { length: 20 }).notNull(),
    blockedReason: text("blocked_reason"),
    actionLogId: uuid("action_log_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clientDecisionIdx: index("idx_intel_decisions_client").on(table.clientId, table.decision),
    createdAtIdx: index("idx_intel_decisions_created").on(table.createdAt),
  }),
);

export const intelligenceActionLinks = pgTable(
  "intelligence_action_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    opportunityId: uuid("opportunity_id").notNull(),
    jobName: varchar("job_name", { length: 100 }),
    // The deterministic BullMQ job id this routing produced. Routing the same
    // opportunity to the same job twice must yield one queued job, one link.
    jobId: varchar("job_id", { length: 255 }),
    actionLogId: uuid("action_log_id"),
    linkedAt: timestamp("linked_at").notNull().defaultNow(),
    // Set once the outcome attributor has measured this routing. The
    // attribution window spans weeks while the job runs weekly, so without a
    // marker every run would re-measure — and re-insert — the same matured
    // routing. NULL means "not yet measured", which is also the state a
    // re-delivered attribution job must not change twice.
    attributedAt: timestamp("attributed_at"),
  },
  (table) => ({
    uniqueRouteIdx: uniqueIndex("uq_intel_links_client_opp_job").on(
      table.clientId,
      table.opportunityId,
      table.jobName,
    ),
    clientIdx: index("idx_intel_links_client").on(table.clientId),
  }),
);

export const buildIntelligenceArtifacts = pgTable(
  "build_intelligence_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    buildId: varchar("build_id", { length: 255 }).notNull(),
    artifactType: varchar("artifact_type", { length: 64 }).notNull(),
    artifactId: varchar("artifact_id", { length: 128 }).notNull().unique(),
    payloadDigest: varchar("payload_digest", { length: 128 }).notNull(),
    payload: jsonb("payload").notNull(),
    producedAt: timestamp("produced_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    clientBuildIdx: index("idx_build_intel_client_build").on(table.clientId, table.buildId),
    typeIdx: index("idx_build_intel_type").on(table.artifactType),
  }),
);
