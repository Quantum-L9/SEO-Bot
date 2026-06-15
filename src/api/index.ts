/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - API Server
 * 
 * Lightweight HTTP API for:
 * - Health checks (Docker/monitoring)
 * - Operator dashboard data
 * - Client status overview
 * - Manual trigger endpoints
 * - Webhook receivers
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../core/database/index.js';
import { createModuleLogger } from '../core/logger.js';
import { getScheduler } from '../core/scheduler.js';
import { registerDashboard } from './dashboard.js';

const logger = createModuleLogger('api');

export async function startApiServer(port: number = 3100): Promise<void> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // ─── Operator Dashboard (HTML) ──────────────────────────────────────────
  await registerDashboard(app);

  // ─── Health Check ────────────────────────────────────────────────────────

  app.get('/health', async () => {
    const db = getDb();
    const scheduler = getScheduler();

    // Check DB connectivity
    let dbOk = false;
    try {
      await db.execute(sql`SELECT 1`);
      dbOk = true;
    } catch { /* noop */ }

    return {
      status: dbOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components: {
        database: dbOk ? 'connected' : 'disconnected',
        scheduler: scheduler.isRunning() ? 'active' : 'stopped',
      },
      version: '1.0.0',
    };
  });

  // ─── Dashboard: All Clients Overview ─────────────────────────────────────

  app.get('/api/clients', async () => {
    const db = getDb();

    const clients = await db.select()
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(schema.clients.name);

    return { clients };
  });

  // ─── Dashboard: Client Detail ────────────────────────────────────────────

  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId', async (request) => {
    const db = getDb();
    const { clientId } = request.params;

    const [client] = await db.select()
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) return { error: 'Client not found' };

    // Get latest rankings
    const rankings = await db.select()
      .from(schema.serpRankings)
      .where(eq(schema.serpRankings.clientId, clientId))
      .orderBy(desc(schema.serpRankings.checkedAt))
      .limit(20);

    // Get latest vitals
    const vitals = await db.select()
      .from(schema.webVitals)
      .where(eq(schema.webVitals.clientId, clientId))
      .orderBy(desc(schema.webVitals.measuredAt))
      .limit(10);

    // Get engagement summary
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);
    const engagement = await db.select()
      .from(schema.pageEngagement)
      .where(and(
        eq(schema.pageEngagement.clientId, clientId),
        gte(schema.pageEngagement.computedAt, oneWeekAgo),
      ))
      .orderBy(desc(schema.pageEngagement.totalPageviews))
      .limit(10);

    // Get link building status
    const prospects = await db.select()
      .from(schema.linkProspects)
      .where(eq(schema.linkProspects.clientId, clientId))
      .orderBy(desc(schema.linkProspects.createdAt))
      .limit(10);

    // Get recent citations
    const citations = await db.select()
      .from(schema.aeoCitations)
      .where(eq(schema.aeoCitations.clientId, clientId))
      .orderBy(desc(schema.aeoCitations.checkedAt))
      .limit(10);

    return {
      client,
      rankings,
      vitals,
      engagement,
      prospects,
      citations,
    };
  });

  // ─── Dashboard: Weekly Report ────────────────────────────────────────────

  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId/report', async (request) => {
    const db = getDb();
    const { clientId } = request.params;

    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);

    // Rankings movement
    const rankings = await db.select()
      .from(schema.serpRankings)
      .where(and(
        eq(schema.serpRankings.clientId, clientId),
        gte(schema.serpRankings.checkedAt, oneWeekAgo),
      ))
      .orderBy(desc(schema.serpRankings.checkedAt));

    const improved = rankings.filter(r => r.previousPosition && r.position && r.position < r.previousPosition);
    const declined = rankings.filter(r => r.previousPosition && r.position && r.position > r.previousPosition);

    // Vitals trend
    const vitals = await db.select()
      .from(schema.webVitals)
      .where(and(
        eq(schema.webVitals.clientId, clientId),
        gte(schema.webVitals.measuredAt, oneWeekAgo),
      ))
      .orderBy(desc(schema.webVitals.measuredAt));

    // Link building progress
    const newProspects = await db.select()
      .from(schema.linkProspects)
      .where(and(
        eq(schema.linkProspects.clientId, clientId),
        gte(schema.linkProspects.createdAt, oneWeekAgo),
      ));

    // Citation rate
    const citations = await db.select()
      .from(schema.aeoCitations)
      .where(and(
        eq(schema.aeoCitations.clientId, clientId),
        gte(schema.aeoCitations.checkedAt, oneWeekAgo),
      ));

    const citationRate = citations.length > 0
      ? (citations.filter(c => c.cited).length / citations.length * 100).toFixed(1)
      : 'N/A';

    return {
      period: { from: oneWeekAgo.toISOString(), to: new Date().toISOString() },
      rankings: {
        total: rankings.length,
        improved: improved.length,
        declined: declined.length,
        topMovers: improved.slice(0, 5).map(r => ({
          keyword: r.keyword,
          from: r.previousPosition,
          to: r.position,
        })),
      },
      vitals: {
        latestLcp: vitals[0]?.lcp || null,
        latestCls: vitals[0]?.cls || null,
        latestInp: vitals[0]?.inp || null,
      },
      linkBuilding: {
        newProspects: newProspects.length,
        readyForOutreach: newProspects.filter(p => p.status === 'ready').length,
        outreachSent: newProspects.filter(p => p.status === 'outreach_queued').length,
      },
      aeo: {
        queriesChecked: citations.length,
        citationRate: `${citationRate}%`,
      },
    };
  });

  // ─── Manual Triggers ─────────────────────────────────────────────────────

  app.post<{ Params: { clientId: string }; Body: { module: string } }>(
    '/api/clients/:clientId/trigger',
    async (request) => {
      const { clientId } = request.params;
      const { module } = request.body as any;
      const scheduler = getScheduler();

      const validModules = [
        'serp:track-rankings',
        'serp:analyze-competitor',
        'vitals:check-all',
        'aeo:check-citations',
        'aeo:optimize-faqs',
        'links:discover-prospects',
        'links:process-outreach',
        'behavior:pull-engagement',
        'behavior:generate-insights',
      ];

      if (!validModules.includes(module)) {
        return { error: `Invalid module. Valid: ${validModules.join(', ')}` };
      }

      // Get client
      const db = getDb();
      const [client] = await db.select()
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) return { error: 'Client not found' };

      // Queue the job
      await scheduler.addJob(module, {
        clientId: client.id,
        clientDomain: client.domain,
        clientConfig: client.config,
      });

      return { success: true, message: `Job ${module} queued for ${client.domain}` };
    }
  );

  // ─── Token Budget Status ─────────────────────────────────────────────────

  app.get('/api/token-budget', async () => {
    const db = getDb();

    const today = new Date().toISOString().split('T')[0];
    const thisMonth = today.slice(0, 7);

    // Get today's usage from action_outcomes
    const outcomes = await db.select()
      .from(schema.actionOutcomes)
      .where(gte(schema.actionOutcomes.executedAt, new Date(today)))
      .orderBy(desc(schema.actionOutcomes.executedAt));

    return {
      date: today,
      month: thisMonth,
      todayActions: outcomes.length,
      message: 'Detailed token tracking available in logs (structured JSON)',
    };
  });

  // ─── Start Server ────────────────────────────────────────────────────────

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'API server started');
  } catch (error: any) {
    logger.error({ error: error.message }, 'API server failed to start');
    throw error;
  }
}
