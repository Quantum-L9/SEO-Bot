/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Module 5: PostHog Behavior Intelligence
 * 
 * The GOLD flow:
 * [Visitor hits Astro site]
 *   → [PostHog JS captures: page view, time on page, scroll %, clicks, nav path]
 *   → [PostHog instance stores events]
 *   → [SEO Bot queries PostHog API daily]
 *   → [Bot learns engagement patterns]
 *   → [Bot acts on insights]
 * 
 * Capabilities:
 * - Daily engagement data pull from PostHog (zero tokens)
 * - Page performance scoring (time on page × scroll depth)
 * - Navigation flow analysis (where do visitors go after landing?)
 * - Conversion path identification (most common path to form submission)
 * - Dead-end detection (pages with high exit rates)
 * - Cross-portfolio benchmarking (compare across all clients)
 * - Weekly insights generation (strategic LLM, Friday only)
 * 
 * Token Budget:
 * - pullEngagementData: 0 tokens (pure API + DB)
 * - generateInsights: ~4000 strategic tokens (weekly only)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { Job } from 'bullmq';
import { eq, and, desc, gte } from 'drizzle-orm';
import { Scheduler } from '../../core/scheduler.js';
import { getConfig } from '../../core/config.js';
import { createModuleLogger } from '../../core/logger.js';
import { getDb, schema } from '../../core/database/index.js';
import { getLlmService } from '../../services/llm.js';
import { getNotificationService } from '../../services/notifications.js';

const logger = createModuleLogger('behavior-intelligence');

// ─── PostHog Query Client ────────────────────────────────────────────────────

class PostHogClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async query(projectId: string, hogql: string): Promise<any[]> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/projects/${projectId}/query`,
        {
          query: { kind: 'HogQLQuery', query: hogql },
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 30000,
        }
      );

      return response.data?.results || [];
    } catch (error: any) {
      logger.error({ error: error.message }, 'PostHog query failed');
      return [];
    }
  }

  async getInsight(projectId: string, insightType: string, params: Record<string, any> = {}): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/projects/${projectId}/insights/trend`,
        {
          insight: insightType,
          ...params,
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 30000,
        }
      );

      return response.data;
    } catch (error: any) {
      logger.error({ insightType, error: error.message }, 'PostHog insight fetch failed');
      return null;
    }
  }
}

// ─── Handler: Pull Engagement Data (ZERO TOKENS) ────────────────────────────

async function pullEngagementData(job: Job): Promise<void> {
  const { clientId, clientDomain } = job.data;
  if (!clientId) return;

  const db = getDb();
  const config = getConfig();

  // Get client's PostHog config
  const [client] = await db.select()
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  if (!client?.posthogProjectId || !client?.posthogApiKey) {
    logger.debug({ clientDomain }, 'No PostHog config — skipping behavior pull');
    return;
  }

  // Query API needs a PostHog PERSONAL API key. client.posthogApiKey is the
  // per-project ingestion key (client-side snippet) and would 401 here. All
  // clients share one PostHog instance, so the global personal key reads any
  // project. The per-client key presence above just signals PostHog is configured.
  const posthog = new PostHogClient(config.POSTHOG_API_URL, config.POSTHOG_PERSONAL_API_KEY);
  const today = new Date().toISOString().split('T')[0];

  logger.info({ clientDomain }, 'Pulling engagement data from PostHog');

  // ─── Query 1: Page-level engagement metrics ─────────────────────────────

  const pageMetrics = await posthog.query(client.posthogProjectId, `
    SELECT
      properties.$current_url as page_url,
      count() as pageviews,
      uniq(distinct_id) as unique_visitors,
      avg(toFloat64OrNull(properties.$session_duration)) as avg_session_duration,
      avg(toFloat64OrNull(properties.scroll_depth)) as avg_scroll_depth
    FROM events
    WHERE event = '$pageview'
      AND timestamp > now() - interval 1 day
    GROUP BY page_url
    ORDER BY pageviews DESC
    LIMIT 50
  `);

  // ─── Query 2: Exit rates per page ──────────────────────────────────────

  const exitRates = await posthog.query(client.posthogProjectId, `
    SELECT
      properties.$current_url as page_url,
      count() as total_views,
      countIf(properties.$is_exit = 'true') as exits,
      exits / total_views as exit_rate
    FROM events
    WHERE event = '$pageview'
      AND timestamp > now() - interval 1 day
    GROUP BY page_url
    HAVING total_views >= 5
    ORDER BY exit_rate DESC
    LIMIT 30
  `);

  // ─── Query 3: Bounce rates per page ────────────────────────────────────

  const bounceRates = await posthog.query(client.posthogProjectId, `
    SELECT
      properties.$entry_current_url as landing_page,
      count() as sessions,
      countIf(properties.$session_page_count = 1) as bounces,
      bounces / sessions as bounce_rate
    FROM events
    WHERE event = '$pageview'
      AND properties.$entry_current_url != ''
      AND timestamp > now() - interval 1 day
    GROUP BY landing_page
    HAVING sessions >= 3
    ORDER BY bounce_rate DESC
    LIMIT 30
  `);

  // ─── Store aggregated data ─────────────────────────────────────────────

  for (const row of pageMetrics) {
    const pagePath = extractPath(row[0]);
    const pageviews = row[1] || 0;
    const uniqueVisitors = row[2] || 0;
    const avgTime = row[3] || 0;
    const avgScroll = row[4] || 0;

    // Find matching exit/bounce rates
    const exitRow = exitRates.find((e: any) => extractPath(e[0]) === pagePath);
    const bounceRow = bounceRates.find((b: any) => extractPath(b[0]) === pagePath);

    await db.insert(schema.pageEngagement).values({
      clientId,
      pagePath,
      avgTimeOnPage: avgTime,
      avgScrollDepth: avgScroll,
      bounceRate: bounceRow ? bounceRow[3] : null,
      exitRate: exitRow ? exitRow[3] : null,
      uniqueVisitors,
      totalPageviews: pageviews,
      period: today,
    });
  }

  logger.info({ clientDomain, pagesTracked: pageMetrics.length }, 'Engagement data stored');
}

// ─── Handler: Generate Insights (STRATEGIC LLM - weekly) ─────────────────────

async function generateInsights(job: Job): Promise<void> {
  const { clientId, clientDomain, clientConfig } = job.data;
  if (!clientId) return;

  const db = getDb();
  const llm = getLlmService();
  const notifications = getNotificationService();

  // Get last 7 days of engagement data
  const oneWeekAgo = new Date(Date.now() - 7 * 86400000);

  const engagement = await db.select()
    .from(schema.pageEngagement)
    .where(and(
      eq(schema.pageEngagement.clientId, clientId),
      gte(schema.pageEngagement.computedAt, oneWeekAgo),
    ))
    .orderBy(desc(schema.pageEngagement.totalPageviews));

  if (engagement.length < 3) {
    logger.info({ clientDomain }, 'Insufficient engagement data for insights');
    return;
  }

  // Compute rankings
  const topByEngagement = [...engagement]
    .sort((a, b) => {
      const scoreA = (a.avgTimeOnPage || 0) * (a.avgScrollDepth || 0.5);
      const scoreB = (b.avgTimeOnPage || 0) * (b.avgScrollDepth || 0.5);
      return scoreB - scoreA;
    })
    .slice(0, 5);

  const deadEnds = engagement
    .filter(e => (e.exitRate || 0) > 0.7 && (e.totalPageviews || 0) >= 5)
    .slice(0, 5);

  const highBounce = engagement
    .filter(e => (e.bounceRate || 0) > 0.8 && (e.totalPageviews || 0) >= 5)
    .slice(0, 5);

  // Generate strategic insights
  const insights = await llm.generateContent(
    `You are an expert conversion rate optimizer and SEO strategist. Analyze this website behavior data and provide actionable insights.

FORMAT: Return a structured report with:
1. TOP PERFORMERS (pages with best engagement — protect and promote these)
2. DEAD ENDS (high exit rate pages — need CTA improvements)
3. BOUNCE PROBLEMS (high bounce pages — content or UX issue)
4. RECOMMENDED ACTIONS (specific, prioritized actions the SEO Bot should take)
5. INTERNAL LINKING RECOMMENDATIONS (which pages should link to which)

Be specific. Reference actual page paths. Give concrete recommendations.`,
    `Domain: ${clientDomain}
Industry: ${clientConfig?.industry || 'local service'}

TOP ENGAGEMENT PAGES:
${topByEngagement.map(p => `${p.pagePath}: ${(p.avgTimeOnPage || 0).toFixed(0)}s avg time, ${((p.avgScrollDepth || 0) * 100).toFixed(0)}% scroll, ${p.totalPageviews} views`).join('\n')}

DEAD ENDS (high exit rate):
${deadEnds.map(p => `${p.pagePath}: ${((p.exitRate || 0) * 100).toFixed(0)}% exit rate, ${p.totalPageviews} views`).join('\n')}

HIGH BOUNCE PAGES:
${highBounce.map(p => `${p.pagePath}: ${((p.bounceRate || 0) * 100).toFixed(0)}% bounce rate, ${p.totalPageviews} views`).join('\n')}

TOTAL PAGES TRACKED: ${engagement.length}
TOTAL WEEKLY PAGEVIEWS: ${engagement.reduce((sum, e) => sum + (e.totalPageviews || 0), 0)}

Generate the behavior intelligence report:`,
    clientId,
    'behavior-intelligence',
    'weekly-insights'
  );

  // Send to operator
  await notifications.sendAlert({
    title: `Behavior Intelligence Report: ${clientDomain}`,
    message: insights,
    severity: 'info',
    clientDomain,
    module: 'behavior-intelligence',
    data: {
      topPages: topByEngagement.map(p => p.pagePath),
      deadEnds: deadEnds.map(p => p.pagePath),
      highBounce: highBounce.map(p => p.pagePath),
      totalPageviews: engagement.reduce((sum, e) => sum + (e.totalPageviews || 0), 0),
    },
  });

  // Store outcome for feedback loop
  await db.insert(schema.actionOutcomes).values({
    clientId,
    module: 'behavior-intelligence',
    action: 'weekly_insights_generated',
    executedAt: new Date(),
    learnings: `Top: ${topByEngagement[0]?.pagePath || 'N/A'}, Dead-end: ${deadEnds[0]?.pagePath || 'none'}, Bounce: ${highBounce[0]?.pagePath || 'none'}`,
  });

  logger.info({ clientDomain }, 'Behavior insights generated and sent');
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url || '/';
  }
}

// ─── Register Handlers ───────────────────────────────────────────────────────

export function registerBehaviorHandlers(scheduler: Scheduler): void {
  scheduler.registerHandler('behavior:pull-engagement', pullEngagementData);
  scheduler.registerHandler('behavior:generate-insights', generateInsights);
  logger.info('Behavior Intelligence handlers registered');
}
