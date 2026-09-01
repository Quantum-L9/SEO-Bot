/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Module 6: Intelligence Control Loop
 *
 * raw facts -> SQL signals -> scored opportunities -> policy-gated decisions
 *   -> existing SEO-Bot jobs -> measured outcomes -> future scoring
 *
 * Registration only. All behaviour lives in IntelligenceService; the handlers
 * here exist to bind job names to it and to enforce that every client-scoped
 * job actually carries a clientId.
 *
 * WHY FIVE JOBS RATHER THAN ONE.
 * The phases could be a single handler. They are five because each has a
 * different blast radius and a different gate, so the deterministic phases can
 * run indefinitely without ever loading the code path that spends tokens or
 * enqueues work. Splitting them means a gate that fails also means the risky
 * code never executes, rather than executing and then declining to act.
 */

import type { Job } from "bullmq";
import { getConfig } from "../../core/config.js";
import { createModuleLogger } from "../../core/logger.js";
import type { Scheduler } from "../../core/scheduler.js";
import { currentCapabilities } from "./capabilities.js";
import { IntelligenceService } from "./intelligence.service.js";
import { requireClientId } from "./policy-gate.js";

const logger = createModuleLogger("intelligence");

/**
 * A client-scoped intelligence job with no clientId is a bug, not an empty run.
 * Throwing surfaces it in job_executions rather than letting a handler quietly
 * do nothing — or, worse, run a query with an undefined tenant filter.
 */
function jobClientId(job: Job): string {
  return requireClientId((job.data as { clientId?: string }).clientId);
}

export function registerIntelligenceHandlers(scheduler: Scheduler): void {
  // Constructed per job rather than once at registration: capabilities are read
  // from config at construction, and a long-lived process should pick up a
  // restart's configuration rather than the one captured at boot.
  const service = () => new IntelligenceService();

  scheduler.registerHandler("intelligence:extract-signals", async (job: Job) => {
    await service().extractSignals(jobClientId(job));
  });

  scheduler.registerHandler("intelligence:score-opportunities", async (job: Job) => {
    await service().scoreOpportunities(jobClientId(job));
  });

  scheduler.registerHandler("intelligence:plan-actions", async (job: Job) => {
    await service().planActions(jobClientId(job));
  });

  scheduler.registerHandler("intelligence:measure-outcomes", async (job: Job) => {
    await service().measureOutcomes(jobClientId(job));
  });

  // Not client-scoped: the portfolio benchmark is the module's one cross-client
  // query and returns anonymized aggregates only.
  scheduler.registerHandler("intelligence:portfolio-benchmark", async () => {
    await service().portfolioBenchmark();
  });

  const caps = currentCapabilities();
  logger.info(
    {
      enabled: caps.enabled,
      llmPlanning: caps.usesLlmPlanner,
      autoRouteLowRisk: caps.autoRouteLowRisk,
      portfolioBenchmark: caps.portfolioBenchmark,
      minScoreToPlan: caps.minScoreToPlan,
      dailySpendCap: getConfig().DAILY_SPEND_CAP ?? null,
    },
    "Intelligence handlers registered",
  );
}

export * from "./action-router.js";
export * from "./capabilities.js";
export * from "./evidence-pack.js";
export * from "./intelligence.service.js";
export * from "./opportunity-scorer.js";
export * from "./outcome-attributor.js";
export * from "./planner.js";
export * from "./policy-gate.js";
export * from "./queries/index.js";
export * from "./signal-extractor.js";
