/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Main Entry Point v1.0.0
 * HTTP API served exclusively via Fastify (src/api/index.ts)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { loadSecrets } from './core/secrets.js';
import { loadConfig } from './core/config.js';
import { createModuleLogger } from './core/logger.js';
import { closeDb } from './core/database/index.js';
import { getScheduler } from './core/scheduler.js';
import { startApiServer } from './api/index.js';
import { registerSerpHandlers } from './modules/serp-intelligence/index.js';
import { registerVitalsHandlers } from './modules/web-vitals/index.js';
import { registerAeoHandlers } from './modules/aeo-geo/index.js';
import { registerLinkHandlers } from './modules/link-building/index.js';
import { registerBehaviorHandlers } from './modules/behavior-intelligence/index.js';
import { registerPlanExecutorHandlers } from './services/plan-executor.js';

const logger = createModuleLogger('main');

async function main() {
  // Hydrate process.env from Infisical before any config is read (no-op when
  // Infisical isn't configured; never overrides vars already set in the env).
  await loadSecrets();

  const config = loadConfig();
  logger.info('Configuration validated');

  const scheduler = getScheduler();
  registerSerpHandlers(scheduler);
  registerVitalsHandlers(scheduler);
  registerAeoHandlers(scheduler);
  registerLinkHandlers(scheduler);
  registerBehaviorHandlers(scheduler);
  registerPlanExecutorHandlers(scheduler); // GAP-07 (C-02); job disabled by default
  await scheduler.start();
  logger.info('All modules registered and scheduler started');

  await startApiServer(config.BOT_PORT);

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
  logger.info('  API: Fastify on port ' + config.BOT_PORT);
  logger.info('═══════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
