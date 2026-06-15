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
  pgTable,
  uuid,
  varchar,
  text,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { clients } from './schema.js';

// ─── Action Log (Execution Policy) ─────────────────────────────────────────────

export const actionLog = pgTable('action_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  module: varchar('module', { length: 50 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  description: text('description').notNull(),
  rationale: text('rationale').notNull(),
  triggeredBy: text('triggered_by').notNull(),
  riskLevel: varchar('risk_level', { length: 20 }).notNull(),
  reversible: boolean('reversible').notNull(),
  status: varchar('status', { length: 30 }).notNull().default('pending_approval'),
  // For multiple-choice approvals
  options: jsonb('options'), // JSON array of ActionOption[]
  aiRecommendation: text('ai_recommendation'),
  aiConfidence: real('ai_confidence'),
  // Approval tracking
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),
  selectedOption: varchar('selected_option', { length: 50 }),
  rejectionReason: text('rejection_reason'),
  // Execution tracking
  executedAt: timestamp('executed_at'),
  executionResult: text('execution_result'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'), // auto-expire pending approvals after 7 days
}, (table) => ({
  clientStatusIdx: index('idx_action_log_client_status').on(table.clientId, table.status),
  createdAtIdx: index('idx_action_log_created').on(table.createdAt),
}));

// ─── Behavior Recommendations ───────────────────────────────────────────────────

export const behaviorRecommendations = pgTable('behavior_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  insight: text('insight').notNull(),
  severity: varchar('severity', { length: 20 }).notNull(), // info, warning, critical
  pagePath: varchar('page_path', { length: 500 }),
  metric: varchar('metric', { length: 50 }), // bounce_rate, time_on_page, scroll_depth, etc.
  currentValue: real('current_value'),
  benchmarkValue: real('benchmark_value'),
  // Multiple choice options
  options: jsonb('options').notNull(), // Array of { id, label, description, risk, recommended, confidence }
  aiRecommendedOption: varchar('ai_recommended_option', { length: 50 }),
  aiRationale: text('ai_rationale'),
  // Resolution
  selectedOption: varchar('selected_option', { length: 50 }),
  resolvedBy: varchar('resolved_by', { length: 50 }), // 'auto' | 'operator'
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  weekOf: varchar('week_of', { length: 10 }).notNull(), // YYYY-WW format
}, (table) => ({
  clientWeekIdx: index('idx_behavior_rec_client_week').on(table.clientId, table.weekOf),
}));
