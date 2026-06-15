/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Core Type Definitions
 * Version: 1.0.0
 * Purpose: Enterprise-grade type system for multi-tenant autonomous SEO engine
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Client / Tenant ─────────────────────────────────────────────────────────

export interface Client {
  id: string;
  name: string;
  domain: string;
  posthogProjectId: string;
  posthogApiKey: string;
  industry: string;
  location: {
    city: string;
    state: string;
    country: string;
  };
  config: ClientConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientConfig {
  targetKeywords: TargetKeyword[];
  competitors: Competitor[];
  linkVelocity: LinkVelocityConfig;
  contentStrategy: ContentStrategyConfig;
  notifications: NotificationConfig;
}

export interface TargetKeyword {
  keyword: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  targetPosition: number;
  currentPosition: number | null;
  pageUrl: string;
}

export interface Competitor {
  domain: string;
  name: string;
  isPrimary: boolean;
}

// ─── SERP Intelligence ───────────────────────────────────────────────────────

export interface SerpResult {
  keyword: string;
  position: number | null;
  url: string;
  previousPosition: number | null;
  positionChange: number;
  topCompetitor: CompetitorSerpEntry;
  serpFeatures: string[];
  checkedAt: Date;
}

export interface CompetitorSerpEntry {
  domain: string;
  position: number;
  url: string;
  title: string;
  snippet: string;
}

export interface GapAnalysis {
  clientId: string;
  keyword: string;
  clientUrl: string;
  competitorUrl: string;
  gaps: GapDimension[];
  surpassPlan: SurpassAction[];
  generatedAt: Date;
}

export interface GapDimension {
  dimension: 'content_depth' | 'schema' | 'backlinks' | 'speed' | 'freshness' | 'serp_features';
  clientScore: number;
  competitorScore: number;
  delta: number;
  details: string;
}

export interface SurpassAction {
  priority: number;
  action: string;
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  autonomous: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

// ─── Web Vitals ──────────────────────────────────────────────────────────────

export interface WebVitalsReport {
  clientId: string;
  url: string;
  source: 'psi' | 'crux' | 'rum' | 'search_console';
  metrics: {
    lcp: number | null;
    inp: number | null;
    cls: number | null;
    fcp: number | null;
    ttfb: number | null;
  };
  rating: 'good' | 'needs_improvement' | 'poor';
  device: 'mobile' | 'desktop';
  measuredAt: Date;
}

export interface VitalsAlert {
  clientId: string;
  url: string;
  metric: string;
  threshold: number;
  actual: number;
  sources: string[];
  severity: 'warning' | 'critical';
  createdAt: Date;
}

// ─── AEO / GEO ──────────────────────────────────────────────────────────────

export interface AeoCitationCheck {
  clientId: string;
  query: string;
  platform: 'chatgpt' | 'perplexity' | 'google_ai';
  cited: boolean;
  citedUrl: string | null;
  competitorCited: string | null;
  checkedAt: Date;
}

export interface FaqOptimization {
  clientId: string;
  pageUrl: string;
  questions: FaqItem[];
  schemaInjected: boolean;
  lastUpdated: Date;
}

export interface FaqItem {
  question: string;
  answerBlock: string;       // 40-60 word extractable citation block
  expandedAnswer: string;    // Full contextual depth
  dataPoints: number;        // Count of statistics included
  targetQuery: string;       // Conversational query this targets
}

// ─── Link Building ───────────────────────────────────────────────────────────

export interface LinkVelocityConfig {
  domainAgeMonths: number;
  maxLinksPerMonth: number;
  maxLinksPerWeek: number;
  anchorDistribution: {
    branded: number;
    nakedUrl: number;
    generic: number;
    exactMatch: number;
    partial: number;
  };
}

export interface LinkProspect {
  id: string;
  clientId: string;
  targetUrl: string;
  contactEmail: string | null;
  contactName: string | null;
  domainRating: number;
  relevanceScore: number;
  tactic: LinkTactic;
  status: ProspectStatus;
  outreachSequence: OutreachStep[];
  createdAt: Date;
  updatedAt: Date;
}

export type LinkTactic =
  | 'guest_post'
  | 'resource_page'
  | 'broken_link'
  | 'unlinked_mention'
  | 'citation'
  | 'content_syndication'
  | 'haro_response'
  | 'scholarship';

export type ProspectStatus =
  | 'discovered'
  | 'qualified'
  | 'outreach_sent'
  | 'follow_up_1'
  | 'follow_up_2'
  | 'follow_up_3'
  | 'replied_positive'
  | 'replied_negative'
  | 'link_acquired'
  | 'archived';

export interface OutreachStep {
  step: number;
  type: 'initial' | 'follow_up';
  subject: string;
  body: string;
  sentAt: Date | null;
  openedAt: Date | null;
  repliedAt: Date | null;
}

// ─── Behavior Intelligence (PostHog) ─────────────────────────────────────────

export interface PageEngagement {
  clientId: string;
  pageUrl: string;
  pagePath: string;
  avgTimeOnPage: number;      // seconds
  avgScrollDepth: number;     // percentage 0-100
  bounceRate: number;         // percentage 0-100
  exitRate: number;           // percentage 0-100
  uniqueVisitors: number;
  totalPageviews: number;
  topEntrySource: string;
  topExitDestination: string;
  period: string;             // e.g., "2026-06-01_2026-06-07"
}

export interface NavigationFlow {
  clientId: string;
  fromPage: string;
  toPage: string;
  transitionCount: number;
  conversionRate: number;     // % of visitors on this path who convert
  period: string;
}

export interface ConversionPath {
  clientId: string;
  path: string[];             // ordered list of pages visited
  frequency: number;
  conversionRate: number;
  avgTimeToConvert: number;   // seconds
}

// ─── Job System ──────────────────────────────────────────────────────────────

export interface JobDefinition {
  name: string;
  module: ModuleName;
  cron: string;
  handler: string;
  clientScoped: boolean;      // true = runs once per client
  tokenBudget: TokenBudget;
  enabled: boolean;
}

export type ModuleName =
  | 'serp-intelligence'
  | 'web-vitals'
  | 'aeo-geo'
  | 'link-building'
  | 'behavior-intelligence';

export interface TokenBudget {
  maxFastTokensPerRun: number;
  maxStrategicTokensPerRun: number;
  cooldownMinutes: number;    // min time between LLM calls for this job
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface NotificationConfig {
  email: boolean;
  telegram: boolean;
  weeklyReport: boolean;
  alertOnRankDrop: number;    // alert if position drops by this many
  alertOnVitalsDegradation: boolean;
}

export interface OperatorReport {
  clientId: string;
  period: string;
  summary: {
    keywordsTracked: number;
    avgPositionChange: number;
    linksAcquired: number;
    contentPublished: number;
    vitalsStatus: 'all_good' | 'needs_attention' | 'critical';
    topPages: string[];
    worstPages: string[];
  };
  actions: {
    completed: SurpassAction[];
    pending: SurpassAction[];
    blocked: SurpassAction[];
  };
  generatedAt: Date;
}

// ─── LLM Integration ─────────────────────────────────────────────────────────

export type LlmTier = 'fast' | 'strategic';

export interface LlmCall {
  tier: LlmTier;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: Date;
  clientId: string;
  module: ModuleName;
}

// ─── Feedback Loop ───────────────────────────────────────────────────────────

export interface ActionOutcome {
  actionId: string;
  clientId: string;
  module: ModuleName;
  action: string;
  executedAt: Date;
  measuredAt: Date;
  positionBefore: number | null;
  positionAfter: number | null;
  trafficBefore: number | null;
  trafficAfter: number | null;
  success: boolean;
  learnings: string;
}
