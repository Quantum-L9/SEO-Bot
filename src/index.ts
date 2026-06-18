/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Main Entry Point
 * Version: 1.0.0
 *
 * Autonomous, multi-tenant SEO optimization engine.
 * Runs 24/7 on Hetzner CX32 via Docker Compose.
 *
 * Architecture:
 * - BullMQ scheduler dispatches cron jobs
 * - 5 modules execute independently
 * - LLM invoked surgically (95% pure code, 5% AI judgment)
 * - PostHog integration for behavior intelligence
 * - Operator notifications via Email + Telegram
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { loadConfig } from './core/config.js';
import { createModuleLogger } from './core/logger.js';
import { getDb, closeDb } from './core/database/index.js';
import { getScheduler } from './core/scheduler.js';
import { getLlmService } from './services/llm.js';

// Module imports
import { registerSerpHandlers } from './modules/serp-intelligence/index.js';
import { registerVitalsHandlers } from './modules/web-vitals/index.js';
import { registerAeoHandlers } from './modules/aeo-geo/index.js';
import { registerLinkHandlers } from './modules/link-building/index.js';
import { registerBehaviorHandlers } from './modules/behavior-intelligence/index.js';

const logger = createModuleLogger('main');

async function main() {
  // ─── Load & Validate Config ──────────────────────────────────────────────
  const config = loadConfig();
  logger.info('Configuration validated');

  // ─── Initialize Database ─────────────────────────────────────────────────
  const db = getDb();
  logger.info('Database connected');

  // ─── Initialize Scheduler ────────────────────────────────────────────────
  const scheduler = getScheduler();

  // Register all module handlers
  registerSerpHandlers(scheduler);
  registerVitalsHandlers(scheduler);
  registerAeoHandlers(scheduler);
  registerLinkHandlers(scheduler);
  registerBehaviorHandlers(scheduler);

  await scheduler.start();
  logger.info('All modules registered and scheduler started');

  // ─── HTTP API (Health + Dashboard) ───────────────────────────────────────
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Status endpoint
  app.get('/api/status', async (req, res) => {
    try {
      const clients = await db.query.clients.findMany({
        where: (clients, { eq }) => eq(clients.active, true),
      });

      res.json({
        status: 'running',
        activeClients: clients.length,
        clients: clients.map(c => ({ id: c.id, domain: c.domain, industry: c.industry })),
        uptime: process.uptime(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // LLM spend endpoint
  // FIX(review): added try/catch — consistent error handling with all other async routes
  app.get('/api/llm-spend', async (req, res) => {
    try {
      const llm = getLlmService();
      res.json({
        dailySpend: llm.getDailySpend(),
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to retrieve LLM spend');
      res.status(500).json({ error: error.message });
    }
  });

  // Start HTTP server
  app.listen(config.BOT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.BOT_PORT }, 'HTTP API server started');
  });

  // ─── Graceful Shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await scheduler.stop();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('  L9 SEO Bot v1.0.0 - OPERATIONAL');
  logger.info('  Modules: SERP | Vitals | AEO/GEO | Links | Behavior');
  logger.info('═══════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
