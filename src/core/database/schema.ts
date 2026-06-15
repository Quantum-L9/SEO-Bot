/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Database Schema (Drizzle ORM)
 * Multi-tenant schema supporting all five modules.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Clients (Tenants) ──────────────────────────────────────────────────────

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }).notNull().unique(),
  posthogProjectId: varchar('posthog_project_id', { length: 100 }),
  posthogApiKey: varchar('posthog_api_key', { length: 255 }),
  industry: varchar('industry', { length: 100 }).notNull(),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 2 }),
  country: varchar('country', { length: 2 }).default('US'),
  config: jsonb('config').notNull().default({}),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ─── SERP Rankings ───────────────────────────────────────────────────────────

export const serpRankings = pgTable('serp_rankings', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  keyword: varchar('keyword', { length: 500 }).notNull(),
  position: integer('position'),
  previousPosition: integer('previous_position'),
  url: text('url'),
  serpFeatures: jsonb('serp_features').default([]),
  device: varchar('device', { length: 10 }).default('desktop'),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
}, (table) => ({
  clientKeywordIdx: index('idx_serp_client_keyword').on(table.clientId, table.keyword),
  checkedAtIdx: index('idx_serp_checked_at').on(table.checkedAt),
}));

// ─── Competitor Snapshots ────────────────────────────────────────────────────

export const competitorSnapshots = pgTable('competitor_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  competitorDomain: varchar('competitor_domain', { length: 255 }).notNull(),
  keyword: varchar('keyword', { length: 500 }).notNull(),
  position: integer('position'),
  url: text('url'),
  title: text('title'),
  snippet: text('snippet'),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
});

// ─── Gap Analyses ────────────────────────────────────────────────────────────

export const gapAnalyses = pgTable('gap_analyses', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  keyword: varchar('keyword', { length: 500 }).notNull(),
  clientUrl: text('client_url'),
  competitorUrl: text('competitor_url'),
  gaps: jsonb('gaps').notNull().default([]),
  surpassPlan: jsonb('surpass_plan').notNull().default([]),
  status: varchar('status', { length: 50 }).default('pending'),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
});

// ─── Web Vitals ──────────────────────────────────────────────────────────────

export const webVitals = pgTable('web_vitals', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  url: text('url').notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  lcp: real('lcp'),
  inp: real('inp'),
  cls: real('cls'),
  fcp: real('fcp'),
  ttfb: real('ttfb'),
  rating: varchar('rating', { length: 20 }),
  device: varchar('device', { length: 10 }).default('mobile'),
  measuredAt: timestamp('measured_at').notNull().defaultNow(),
}, (table) => ({
  clientUrlIdx: index('idx_vitals_client_url').on(table.clientId, table.url),
}));

// ─── AEO Citations ──────────────────────────────────────────────────────────

export const aeoCitations = pgTable('aeo_citations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  query: text('query').notNull(),
  platform: varchar('platform', { length: 50 }).notNull(),
  cited: boolean('cited').notNull().default(false),
  citedUrl: text('cited_url'),
  competitorCited: varchar('competitor_cited', { length: 255 }),
  checkedAt: timestamp('checked_at').notNull().defaultNow(),
});

// ─── FAQ Optimizations ───────────────────────────────────────────────────────

export const faqOptimizations = pgTable('faq_optimizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  pageUrl: text('page_url').notNull(),
  questions: jsonb('questions').notNull().default([]),
  schemaInjected: boolean('schema_injected').default(false),
  lastUpdated: timestamp('last_updated').notNull().defaultNow(),
});

// ─── Link Prospects ──────────────────────────────────────────────────────────

export const linkProspects = pgTable('link_prospects', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  targetUrl: text('target_url').notNull(),
  contactEmail: varchar('contact_email', { length: 255 }),
  contactName: varchar('contact_name', { length: 255 }),
  domainRating: integer('domain_rating'),
  relevanceScore: real('relevance_score'),
  tactic: varchar('tactic', { length: 50 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('discovered'),
  outreachSequence: jsonb('outreach_sequence').default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  clientStatusIdx: index('idx_links_client_status').on(table.clientId, table.status),
}));

// ─── Page Engagement (PostHog Aggregates) ────────────────────────────────────

export const pageEngagement = pgTable('page_engagement', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  pagePath: varchar('page_path', { length: 500 }).notNull(),
  avgTimeOnPage: real('avg_time_on_page'),
  avgScrollDepth: real('avg_scroll_depth'),
  bounceRate: real('bounce_rate'),
  exitRate: real('exit_rate'),
  uniqueVisitors: integer('unique_visitors'),
  totalPageviews: integer('total_pageviews'),
  period: varchar('period', { length: 30 }).notNull(),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (table) => ({
  clientPeriodIdx: index('idx_engagement_client_period').on(table.clientId, table.period),
}));

// ─── LLM Usage Tracking ─────────────────────────────────────────────────────

export const llmUsage = pgTable('llm_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  module: varchar('module', { length: 50 }).notNull(),
  tier: varchar('tier', { length: 20 }).notNull(),
  purpose: text('purpose').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cost: real('cost').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
});

// ─── Action Outcomes (Feedback Loop) ─────────────────────────────────────────

export const actionOutcomes = pgTable('action_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  module: varchar('module', { length: 50 }).notNull(),
  action: text('action').notNull(),
  executedAt: timestamp('executed_at').notNull(),
  measuredAt: timestamp('measured_at'),
  positionBefore: integer('position_before'),
  positionAfter: integer('position_after'),
  trafficBefore: integer('traffic_before'),
  trafficAfter: integer('traffic_after'),
  success: boolean('success'),
  learnings: text('learnings'),
});

// ─── Job Execution Log ───────────────────────────────────────────────────────

export const jobExecutions = pgTable('job_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobName: varchar('job_name', { length: 100 }).notNull(),
  clientId: uuid('client_id'),
  status: varchar('status', { length: 20 }).notNull(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
  metadata: jsonb('metadata').default({}),
}, (table) => ({
  jobNameIdx: index('idx_jobs_name').on(table.jobName),
  startedAtIdx: index('idx_jobs_started').on(table.startedAt),
}));
