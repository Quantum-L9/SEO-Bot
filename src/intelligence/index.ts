/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Plane Registration (ADR-0015, ADR-0016)
 *
 * Job definitions and handlers for the reasoning loop and the reporting plane's
 * materialized refresh.
 *
 * Token budgets are all zero, deliberately. Extraction, grouping, scoring, and
 * the policy gate are deterministic SQL and arithmetic; the plane spends nothing
 * to decide. Tokens are spent later, by the module jobs it queues, under those
 * jobs' own budgets — which is what keeps a continuously-reasoning bot from
 * being a continuously-billing one.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { Job } from "bullmq";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { refreshMaterializedViews } from "../reporting/refresh.js";
import { measureDueExperiments } from "./outcome-attributor.js";
import { refreshAllPolicyState, runClientTriage } from "./runner.js";

const logger = createModuleLogger("intelligence");

export const INTELLIGENCE_JOBS = {
  dailyTriage: "intel:daily-triage",
  outcomeAttribution: "intel:outcome-attribution",
  policyRefresh: "intel:refresh-policy-state",
  reportingRefresh: "reporting:refresh-materialized",
} as const;

const ZERO_TOKENS = {
  maxFastTokensPerRun: 0,
  maxStrategicTokensPerRun: 0,
  cooldownMinutes: 0,
} as const;

export function registerIntelligenceHandlers(scheduler: Scheduler): void {
  // Runs after the overnight collection jobs (SERP 06:00, engagement 05:00,
  // vitals every 6h) so it reasons over the day's fresh facts rather than
  // yesterday's.
  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.dailyTriage,
    module: "intelligence",
    cron: "30 7 * * *",
    handler: "runDailyTriage",
    clientScoped: true,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: true,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.outcomeAttribution,
    module: "intelligence",
    cron: "0 4 * * *",
    handler: "measureOutcomes",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: true,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.policyRefresh,
    module: "intelligence",
    cron: "0 */4 * * *",
    handler: "refreshPolicyState",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: true,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.reportingRefresh,
    module: "reporting",
    cron: "15 */6 * * *",
    handler: "refreshMaterializedViews",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: true,
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.dailyTriage, async (job: Job) => {
    const clientId = job.data?.clientId;
    if (typeof clientId !== "string" || clientId === "") {
      // Reached only if a client-scoped job somehow arrives without fan-out.
      logger.warn({ jobId: job.id }, "Daily triage received no clientId — skipping");
      return;
    }
    await runClientTriage(clientId, "cron", scheduler);
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.outcomeAttribution, async () => {
    const measured = await measureDueExperiments();
    const byVerdict = measured.reduce<Record<string, number>>((counts, experiment) => {
      counts[experiment.verdict] = (counts[experiment.verdict] ?? 0) + 1;
      return counts;
    }, {});
    logger.info({ measured: measured.length, byVerdict }, "Attribution pass completed");
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.policyRefresh, async () => {
    const refreshed = await refreshAllPolicyState();
    logger.info({ refreshed }, "Policy state refreshed for active clients");
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.reportingRefresh, async () => {
    const outcomes = await refreshMaterializedViews();
    const failed = outcomes.filter((outcome) => outcome.status === "error");
    logger.info(
      { refreshed: outcomes.length - failed.length, failed: failed.length },
      "Materialized reporting views refreshed",
    );
    // A failed refresh means the portfolio views are serving a stale snapshot.
    // Throwing records it as a failed job execution, which is what the
    // job_failure_cluster extractor watches for.
    if (failed.length > 0) {
      throw new Error(
        `Materialized view refresh failed for: ${failed.map((f) => f.viewName).join(", ")}`,
      );
    }
  });

  logger.info("Intelligence plane handlers registered");
}
