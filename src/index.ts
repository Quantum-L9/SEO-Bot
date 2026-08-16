/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 * version: 2.1.0
 */
import { eq } from "drizzle-orm";
import { startApiServer } from "./api/index.js";
import { loadConfig } from "./core/config.js";
import { closeDb, getDb, schema } from "./core/database/index.js";
import { createModuleLogger } from "./core/logger.js";
import { getScheduler } from "./core/scheduler.js";
import { hydrateSecretsIfConfigured } from "./core/secrets.js";
import { registerAeoHandlers } from "./modules/aeo-geo/index.js";
import { registerBehaviorHandlers } from "./modules/behavior-intelligence/index.js";
import { registerLinkHandlers } from "./modules/link-building/index.js";
import { registerSerpHandlers } from "./modules/serp-intelligence/index.js";
import { registerVitalsHandlers } from "./modules/web-vitals/index.js";
import { getLlmService } from "./services/llm.js";
import { registerMemoryHandlers } from "./services/memory.js";
import { registerPlanExecutorHandlers } from "./services/plan-executor.js";

const logger = createModuleLogger("main");

async function initializeActiveClientBudgets(): Promise<void> {
  const activeClients = await getDb()
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.active, true));
  const llm = getLlmService();
  const expiredReservations = await llm.recoverExpiredBudgetReservations();

  logger.info(
    { clientCount: activeClients.length, expiredReservations },
    "Persistent LLM budget accounts initialized",
  );
}

async function main() {
  const secretsMeta = await hydrateSecretsIfConfigured();
  logger.info(
    { source_mode: secretsMeta.source_mode, bootstrap_present: secretsMeta.bootstrap_present },
    "Secrets plane ready",
  );
  const config = loadConfig();
  logger.info("Configuration validated");
  await initializeActiveClientBudgets();

  const scheduler = getScheduler();
  registerSerpHandlers(scheduler);
  registerVitalsHandlers(scheduler);
  registerAeoHandlers(scheduler);
  registerLinkHandlers(scheduler);
  registerBehaviorHandlers(scheduler);
  registerPlanExecutorHandlers(scheduler);
  registerMemoryHandlers(scheduler);
  await scheduler.start();
  logger.info("All modules registered and scheduler started");

  await startApiServer(config.BOT_PORT);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    await scheduler.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info(
    "L9 SEO Bot operational: SERP | Vitals | AEO/GEO | Links | Behavior | Governed Memory",
  );
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
