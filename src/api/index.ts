/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - API Server (Fastify — sole HTTP server)
 *
 * T2.2 FIX: Express server removed from src/index.ts.
 * All HTTP traffic now routes through this single Fastify instance.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import formBody from '@fastify/formbody';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '../core/database/index.js';
import { createModuleLogger } from '../core/logger.js';
import { getScheduler } from '../core/scheduler.js';
import { getLlmService } from '../services/llm.js';
import { registerDashboard } from './dashboard.js';
import { registerClientRoutes } from './clients/register.js';
import { registerApiSecurity } from './security.js';
import { getConfig } from '../core/config.js';

const logger = createModuleLogger('api');

export async function startApiServer(port: number = 3100): Promise<void> {
  // trustProxy so request.ip (and the per-IP rate limiter) use X-Forwarded-For
  // when deployed behind a reverse proxy / tunnel. Explicit + configurable.
  const app = Fastify({ logger: false, trustProxy: getConfig().TRUST_PROXY });

  await app.register(helmet);
  await app.register(formBody);
  // Operator-only surface: CORS disabled (same-origin) unless an explicit
  // allow-list is configured. `origin: true` (reflect any origin) removed.
  const allowedOrigins = getConfig().DASHBOARD_ALLOWED_ORIGINS;
  await app.register(cors, {
    origin: allowedOrigins ? allowedOrigins.split(',').map((o) => o.trim()).filter(Boolean) : false,
    credentials: true,
  });

  // Rate limiting + operator authentication, before any route.
  registerApiSecurity(app);

  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, url: request.url, method: request.method }, 'API route error');
    const status = error.statusCode ?? 500;
    // Don't leak internal error detail on 5xx; 4xx messages are safe (validation, etc.).
    reply.status(status).send({ error: status < 500 ? error.message : 'Internal Server Error' });
  });

  await registerDashboard(app);
  await registerClientRoutes(app);

  app.get('/health', async () => {
    const db = getDb();
    const scheduler = getScheduler();
    let dbOk = false;
    try { await db.execute(sql`SELECT 1`); dbOk = true; } catch { /* noop */ }
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

  app.get('/api/status', async () => {
    const db = getDb();
    const clients = await db.select()
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(schema.clients.name);
    return {
      status: 'running',
      activeClients: clients.length,
      clients: clients.map(c => ({ id: c.id, domain: c.domain, industry: c.industry })),
      uptime: process.uptime(),
    };
  });

  app.get('/api/llm-spend', async () => {
    const llm = getLlmService();
    return {
      dailySpend: await llm.getDailySpend(),
      timestamp: new Date().toISOString(),
    };
  });

  // Column allow-list — NEVER serialize posthogApiKey / posthogProjectId.
  const publicClientColumns = {
    id: schema.clients.id,
    name: schema.clients.name,
    domain: schema.clients.domain,
    industry: schema.clients.industry,
    city: schema.clients.city,
    state: schema.clients.state,
    country: schema.clients.country,
    config: schema.clients.config,
    active: schema.clients.active,
    createdAt: schema.clients.createdAt,
    updatedAt: schema.clients.updatedAt,
  };

  app.get('/api/clients', async () => {
    const db = getDb();
    const clients = await db.select(publicClientColumns)
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(schema.clients.name);
    return { clients };
  });

  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId', async (request) => {
    const db = getDb();
    const { clientId } = request.params;
    const [client] = await db.select(publicClientColumns).from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1);
    if (!client) return { error: 'Client not found' };
    const rankings = await db.select().from(schema.serpRankings).where(eq(schema.serpRankings.clientId, clientId)).orderBy(desc(schema.serpRankings.checkedAt)).limit(20);
    const vitals = await db.select().from(schema.webVitals).where(eq(schema.webVitals.clientId, clientId)).orderBy(desc(schema.webVitals.measuredAt)).limit(10);
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);
    const engagement = await db.select().from(schema.pageEngagement).where(and(eq(schema.pageEngagement.clientId, clientId), gte(schema.pageEngagement.computedAt, oneWeekAgo))).orderBy(desc(schema.pageEngagement.totalPageviews)).limit(10);
    const prospects = await db.select().from(schema.linkProspects).where(eq(schema.linkProspects.clientId, clientId)).orderBy(desc(schema.linkProspects.createdAt)).limit(10);
    const citations = await db.select().from(schema.aeoCitations).where(eq(schema.aeoCitations.clientId, clientId)).orderBy(desc(schema.aeoCitations.checkedAt)).limit(10);
    return { client, rankings, vitals, engagement, prospects, citations };
  });

  app.get<{ Params: { clientId: string } }>('/api/clients/:clientId/report', async (request) => {
    const db = getDb();
    const { clientId } = request.params;
    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);
    const rankings = await db.select().from(schema.serpRankings).where(and(eq(schema.serpRankings.clientId, clientId), gte(schema.serpRankings.checkedAt, oneWeekAgo))).orderBy(desc(schema.serpRankings.checkedAt));
    const improved = rankings.filter(r => r.previousPosition && r.position && r.position < r.previousPosition);
    const declined = rankings.filter(r => r.previousPosition && r.position && r.position > r.previousPosition);
    const vitals = await db.select().from(schema.webVitals).where(and(eq(schema.webVitals.clientId, clientId), gte(schema.webVitals.measuredAt, oneWeekAgo))).orderBy(desc(schema.webVitals.measuredAt));
    const newProspects = await db.select().from(schema.linkProspects).where(and(eq(schema.linkProspects.clientId, clientId), gte(schema.linkProspects.createdAt, oneWeekAgo)));
    const citations = await db.select().from(schema.aeoCitations).where(and(eq(schema.aeoCitations.clientId, clientId), gte(schema.aeoCitations.checkedAt, oneWeekAgo)));
    const citationRate = citations.length > 0
      ? (citations.filter(c => c.cited).length / citations.length * 100).toFixed(1)
      : 'N/A';
    return {
      period: { from: oneWeekAgo.toISOString(), to: new Date().toISOString() },
      rankings: { total: rankings.length, improved: improved.length, declined: declined.length, topMovers: improved.slice(0, 5).map(r => ({ keyword: r.keyword, from: r.previousPosition, to: r.position })) },
      vitals: { latestLcp: vitals[0]?.lcp || null, latestCls: vitals[0]?.cls || null, latestInp: vitals[0]?.inp || null },
      linkBuilding: { newProspects: newProspects.length, readyForOutreach: newProspects.filter(p => p.status === 'ready').length, outreachSent: newProspects.filter(p => p.status === 'outreach_queued').length },
      aeo: { queriesChecked: citations.length, citationRate: `${citationRate}%` },
    };
  });

  app.post<{ Params: { clientId: string }; Body: { module: string } }>('/api/clients/:clientId/trigger', async (request) => {
    const { clientId } = request.params;
    const { module } = request.body as any;
    const scheduler = getScheduler();
    const validModules = [
      'serp:check-rankings', 'serp:competitor-analysis', 'serp:generate-surpass-plan',
      'vitals:check-all-sources', 'aeo:check-citations', 'aeo:optimize-faqs',
      'links:discover-prospects', 'links:process-outreach',
      'behavior:pull-engagement', 'behavior:generate-insights',
    ];
    if (!validModules.includes(module)) return { error: `Invalid module. Valid: ${validModules.join(', ')}` };
    const db = getDb();
    const [client] = await db.select().from(schema.clients).where(eq(schema.clients.id, clientId)).limit(1);
    if (!client) return { error: 'Client not found' };
    await scheduler.addJob(module, { clientId: client.id, clientDomain: client.domain, clientConfig: client.config });
    return { success: true, message: `Job ${module} queued for ${client.domain}` };
  });

  app.get('/api/token-budget', async () => {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const outcomes = await db.select().from(schema.actionOutcomes).where(gte(schema.actionOutcomes.executedAt, new Date(today))).orderBy(desc(schema.actionOutcomes.executedAt));
    return { date: today, month: today.slice(0, 7), todayActions: outcomes.length, message: 'Detailed token tracking available in logs' };
  });

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'API server started (Fastify — sole HTTP server)');
  } catch (error: any) {
    logger.error({ error: error.message }, 'API server failed to start');
    throw error;
  }
}
