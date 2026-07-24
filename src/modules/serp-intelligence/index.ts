/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Module 1: SERP Intelligence
 * 
 * Capabilities:
 * - Daily rank tracking via DataForSEO (zero tokens)
 * - Competitor position monitoring (zero tokens)
 * - Automated gap analysis across 6 dimensions (fast LLM for scoring)
 * - Surpass plan generation (strategic LLM, used weekly)
 * - Circuit breaker: alerts if position drops >3 spots
 * 
 * Token Budget:
 * - checkRankings: 0 tokens (pure API + DB)
 * - analyzeCompetitors: ~2000 fast tokens (scoring)
 * - generateSurpassPlan: ~8000 strategic tokens (weekly only)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { Job } from 'bullmq';
import { eq, and, desc } from 'drizzle-orm';
import { Scheduler } from '../../core/scheduler.js';
import { getConfig } from '../../core/config.js';
import { createModuleLogger } from '../../core/logger.js';
import { getDb, schema } from '../../core/database/index.js';
import { getLlmService } from '../../services/llm.js';
import { getNotificationService } from '../../services/notifications.js';
import type { GapDimension, SurpassAction } from '../../types/index.js';

const logger = createModuleLogger('serp-intelligence');

// ─── DataForSEO Client ───────────────────────────────────────────────────────

class DataForSeoClient {
  private baseUrl = 'https://api.dataforseo.com/v3';
  private auth: string;

  constructor() {
    const config = getConfig();
    this.auth = Buffer.from(`${config.DATAFORSEO_LOGIN}:${config.DATAFORSEO_PASSWORD}`).toString('base64');
  }

  private async request(endpoint: string, data: any[]): Promise<any> {
    const response = await axios.post(`${this.baseUrl}${endpoint}`, data, {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (response.data.status_code !== 20000) {
      throw new Error(`DataForSEO error: ${response.data.status_message}`);
    }

    return response.data;
  }

  async getRankings(keyword: string, domain: string, location: string = 'United States'): Promise<{
    position: number | null;
    url: string | null;
    serpFeatures: string[];
    competitors: Array<{ domain: string; position: number; url: string; title: string; snippet: string }>;
  }> {
    const result = await this.request('/serp/google/organic/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
      device: 'desktop',
      depth: 20,
    }]);

    const items = result.tasks?.[0]?.result?.[0]?.items || [];
    const serpFeatures = result.tasks?.[0]?.result?.[0]?.item_types || [];

    let position: number | null = null;
    let url: string | null = null;
    const competitors: Array<{ domain: string; position: number; url: string; title: string; snippet: string }> = [];

    for (const item of items) {
      if (item.type !== 'organic') continue;

      const itemDomain = new URL(item.url).hostname.replace('www.', '');

      if (itemDomain === domain.replace('www.', '')) {
        position = item.rank_absolute;
        url = item.url;
      } else {
        competitors.push({
          domain: itemDomain,
          position: item.rank_absolute,
          url: item.url,
          title: item.title || '',
          snippet: item.description || '',
        });
      }
    }

    return { position, url, serpFeatures, competitors };
  }

  async getBacklinkProfile(domain: string): Promise<{
    totalBacklinks: number;
    referringDomains: number;
    domainRating: number;
  }> {
    const result = await this.request('/backlinks/summary/live', [{
      target: domain,
      internal_list_limit: 0,
    }]);

    const data = result.tasks?.[0]?.result?.[0] || {};
    return {
      totalBacklinks: data.total_backlinks || 0,
      referringDomains: data.referring_domains || 0,
      domainRating: data.rank || 0,
    };
  }

  async getPageContent(url: string): Promise<{
    wordCount: number;
    headings: number;
    images: number;
    internalLinks: number;
    externalLinks: number;
  }> {
    const result = await this.request('/on_page/instant_pages', [{
      url,
      load_resources: false,
    }]);

    const page = result.tasks?.[0]?.result?.[0]?.items?.[0] || {};
    return {
      wordCount: page.meta?.content?.plain_text_word_count || 0,
      headings: (page.meta?.htags?.h1?.length || 0) + (page.meta?.htags?.h2?.length || 0) + (page.meta?.htags?.h3?.length || 0),
      images: page.meta?.images_count || 0,
      internalLinks: page.meta?.internal_links_count || 0,
      externalLinks: page.meta?.external_links_count || 0,
    };
  }
}

// ─── Handler: Check Rankings (ZERO TOKENS) ───────────────────────────────────

async function checkRankings(job: Job): Promise<void> {
  const { clientId, clientDomain, clientConfig } = job.data;
  if (!clientId) return;

  const db = getDb();
  const client = new DataForSeoClient();
  const notifications = getNotificationService();
  const keywords = clientConfig?.targetKeywords || [];

  logger.info({ clientDomain, keywordCount: keywords.length }, 'Checking rankings');

  for (const kw of keywords) {
    try {
      const result = await client.getRankings(kw.keyword, clientDomain);

      // Get previous position
      const [previous] = await db.select()
        .from(schema.serpRankings)
        .where(and(
          eq(schema.serpRankings.clientId, clientId),
          eq(schema.serpRankings.keyword, kw.keyword),
        ))
        .orderBy(desc(schema.serpRankings.checkedAt))
        .limit(1);

      const previousPosition = previous?.position || null;
      const positionChange = (previousPosition && result.position)
        ? previousPosition - result.position
        : 0;

      // Store ranking
      await db.insert(schema.serpRankings).values({
        clientId,
        keyword: kw.keyword,
        position: result.position,
        previousPosition,
        url: result.url,
        serpFeatures: result.serpFeatures,
      });

      // Store top competitors
      for (const comp of result.competitors.slice(0, 5)) {
        await db.insert(schema.competitorSnapshots).values({
          clientId,
          competitorDomain: comp.domain,
          keyword: kw.keyword,
          position: comp.position,
          url: comp.url,
          title: comp.title,
          snippet: comp.snippet,
        });
      }

      // Circuit breaker: Alert on significant drop
      if (positionChange < -3 && previousPosition && previousPosition <= 10) {
        await notifications.sendAlert({
          title: `Rank Drop: "${kw.keyword}"`,
          message: `Position dropped from #${previousPosition} to #${result.position} (${positionChange} spots)`,
          severity: positionChange < -5 ? 'critical' : 'warning',
          clientDomain,
          module: 'serp-intelligence',
          data: { keyword: kw.keyword, previousPosition, currentPosition: result.position },
        });
      }

      // Rate limit: 1 request per 2 seconds
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error: any) {
      logger.error({ keyword: kw.keyword, error: error.message }, 'Failed to check ranking');
    }
  }

  logger.info({ clientDomain }, 'Rankings check complete');
}

// ─── Handler: Analyze Competitors (FAST LLM for scoring) ─────────────────────

async function analyzeCompetitors(job: Job): Promise<void> {
  const { clientId, clientDomain, clientConfig } = job.data;
  if (!clientId) return;

  const db = getDb();
  const dataForSeo = new DataForSeoClient();
  const llm = getLlmService();
  const keywords = clientConfig?.targetKeywords?.filter((k: any) => k.priority === 'critical' || k.priority === 'high') || [];

  logger.info({ clientDomain, keywordCount: keywords.length }, 'Analyzing competitors');

  for (const kw of keywords) {
    try {
      // Get current SERP state
      const serp = await dataForSeo.getRankings(kw.keyword, clientDomain);
      if (!serp.competitors.length) continue;

      const topCompetitor = serp.competitors[0];

      // Get content metrics for both pages (zero tokens - pure API)
      const [clientContent, competitorContent] = await Promise.all([
        serp.url ? dataForSeo.getPageContent(serp.url) : null,
        dataForSeo.getPageContent(topCompetitor.url),
      ]);

      // Get backlink profiles (zero tokens - pure API)
      const [clientBacklinks, competitorBacklinks] = await Promise.all([
        dataForSeo.getBacklinkProfile(clientDomain),
        dataForSeo.getBacklinkProfile(topCompetitor.domain),
      ]);

      // Score gaps across 6 dimensions (FAST LLM - cheap classification)
      const gapData = {
        keyword: kw.keyword,
        client: { position: serp.position, content: clientContent, backlinks: clientBacklinks },
        competitor: { position: topCompetitor.position, content: competitorContent, backlinks: competitorBacklinks, domain: topCompetitor.domain },
      };

      const gaps = await llm.extractJson<GapDimension[]>(
        `Score the competitive gap between client and competitor across these 6 dimensions. 
Return a JSON array of objects with: dimension, clientScore (0-100), competitorScore (0-100), delta, details.

Dimensions: content_depth, schema, backlinks, speed, freshness, serp_features

Data:
${JSON.stringify(gapData, null, 2)}

Score based on: content_depth (word count, headings, images), schema (structured data presence), 
backlinks (referring domains, DR), speed (assume equal if no data), freshness (recent update signals), 
serp_features (featured snippets, PAA, etc.)`,
        clientId,
        'serp-intelligence',
        `gap-analysis:${kw.keyword}`
      );

      // Store gap analysis
      await db.insert(schema.gapAnalyses).values({
        clientId,
        keyword: kw.keyword,
        clientUrl: serp.url,
        competitorUrl: topCompetitor.url,
        gaps,
        status: 'pending',
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

    } catch (error: any) {
      logger.error({ keyword: kw.keyword, error: error.message }, 'Competitor analysis failed');
    }
  }
}

// ─── Handler: Generate Surpass Plan (STRATEGIC LLM - weekly) ─────────────────

async function generateSurpassPlan(job: Job): Promise<void> {
  const { clientId, clientDomain } = job.data;
  if (!clientId) return;

  const db = getDb();
  const llm = getLlmService();

  // Get latest gap analyses that need plans
  const pendingGaps = await db.select()
    .from(schema.gapAnalyses)
    .where(and(
      eq(schema.gapAnalyses.clientId, clientId),
      eq(schema.gapAnalyses.status, 'pending'),
    ))
    .orderBy(desc(schema.gapAnalyses.generatedAt))
    .limit(3); // Only top 3 keywords per week

  if (!pendingGaps.length) {
    logger.info({ clientDomain }, 'No pending gap analyses — skipping surpass plan');
    return;
  }

  logger.info({ clientDomain, gapCount: pendingGaps.length }, 'Generating surpass plans');

  for (const gap of pendingGaps) {
    try {
      const planJson = await llm.generateContent(
        `You are an elite SEO strategist. Generate a specific, actionable surpass plan to outrank the competitor.
Each action must be concrete (not vague), have clear effort/impact scoring, and indicate whether the SEO Bot can execute it autonomously.
Return valid JSON: an array of objects with: priority (1-5), action (specific task), effort (low/medium/high), impact (low/medium/high), autonomous (boolean), status ("pending").
Maximum 5 actions. Prioritize high-impact, low-effort, autonomous actions first.`,
        `Client domain: ${clientDomain}
Keyword: ${gap.keyword}
Client URL: ${gap.clientUrl}
Competitor URL: ${gap.competitorUrl}
Gap Analysis:
${JSON.stringify(gap.gaps, null, 2)}

Generate the surpass plan:`,
        clientId,
        'serp-intelligence',
        `surpass-plan:${gap.keyword}`
      );

      let surpassPlan: SurpassAction[];
      try {
        surpassPlan = JSON.parse(planJson);
      } catch {
        // If LLM didn't return valid JSON, wrap it
        surpassPlan = [{ priority: 1, action: planJson, effort: 'medium', impact: 'high', autonomous: false, status: 'pending' }];
      }

      // Update gap analysis with plan
      await db.update(schema.gapAnalyses)
        .set({ surpassPlan, status: 'planned' })
        .where(eq(schema.gapAnalyses.id, gap.id));

      logger.info({ keyword: gap.keyword, actionCount: surpassPlan.length }, 'Surpass plan generated');

    } catch (error: any) {
      logger.error({ keyword: gap.keyword, error: error.message }, 'Surpass plan generation failed');
    }
  }
}

// ─── Handler: Weekly Report ──────────────────────────────────────────────────

async function generateWeeklyReport(job: Job): Promise<void> {
  const { clientId, clientDomain } = job.data;
  if (!clientId) return;

  const db = getDb();
  const llm = getLlmService();
  const notifications = getNotificationService();

  // Gather week's data

  const rankings = await db.select()
    .from(schema.serpRankings)
    .where(and(
      eq(schema.serpRankings.clientId, clientId),
    ))
    .orderBy(desc(schema.serpRankings.checkedAt))
    .limit(50);

  const recentGaps = await db.select()
    .from(schema.gapAnalyses)
    .where(eq(schema.gapAnalyses.clientId, clientId))
    .orderBy(desc(schema.gapAnalyses.generatedAt))
    .limit(5);

  // Generate summary with fast LLM (cheap)
  const summaryContent = await llm.generateContent(
    'Generate a concise weekly SEO report summary in HTML format. Include key metrics, wins, and action items.',
    `Client: ${clientDomain}
Rankings data (latest): ${JSON.stringify(rankings.slice(0, 10).map(r => ({ keyword: r.keyword, position: r.position, prev: r.previousPosition })))}
Gap analyses: ${recentGaps.length} pending
Generate a brief HTML report.`,
    clientId,
    'serp-intelligence',
    'weekly-report-generation',
  );
  const summary = { content: summaryContent };

  await notifications.sendWeeklyReport({
    clientDomain,
    summary: `Weekly SEO Report for ${clientDomain}`,
    htmlReport: summary.content,
  });

  logger.info({ clientDomain }, 'Weekly report sent');
}

// ─── Register Handlers ───────────────────────────────────────────────────────

export function registerSerpHandlers(scheduler: Scheduler): void {
  scheduler.registerHandler('serp:check-rankings', checkRankings);
  scheduler.registerHandler('serp:competitor-analysis', analyzeCompetitors);
  scheduler.registerHandler('serp:generate-surpass-plan', generateSurpassPlan);
  scheduler.registerHandler('reports:weekly-summary', generateWeeklyReport);
  logger.info('SERP Intelligence handlers registered');
}
