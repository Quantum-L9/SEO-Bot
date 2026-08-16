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
