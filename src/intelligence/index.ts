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
 * Token budgets are zero on every job but one. Extraction, grouping, scoring,
 * the policy gate, attribution and the lifecycle are deterministic SQL and
 * arithmetic; the plane spends nothing to REASON. Tokens are spent later, by the
 * module jobs it queues, under those jobs\' own budgets — which is what keeps a
 * continuously-reasoning bot from being a continuously-billing one.
 *
 * The exception is `intel:synthesize-plans` (contract C2), which ranks the
 * remedies for proposals awaiting an operator\'s approval. It carries a real
 * budget because it genuinely spends, and it is the only definition here that
 * does — `registration.test.ts` pins that as a list of one rather than as a
 * blanket rule, so a second budgeted job cannot appear unnoticed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { Job } from "bullmq";
import { getConfig } from "../core/config.js";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { refreshMaterializedViews } from "../reporting/refresh.js";
import {
  assertLifecycleConfig,
  expireStaleOpportunities,
  sweepApprovedActions,
} from "./lifecycle.js";
import { resolveCapabilities } from "./mode.js";
import { measureDueExperiments } from "./outcome-attributor.js";
import { synthesizePendingProposals } from "./plan-synthesizer.js";
import { runPortfolioBenchmark } from "./portfolio.js";
import { refreshAllPolicyState, runClientTriage } from "./runner.js";

const logger = createModuleLogger("intelligence");

export const INTELLIGENCE_JOBS = {
  dailyTriage: "intel:daily-triage",
  outcomeAttribution: "intel:outcome-attribution",
  policyRefresh: "intel:refresh-policy-state",
  lifecycleSweep: "intel:lifecycle-sweep",
  portfolioBenchmark: "intel:weekly-portfolio",
  planSynthesis: "intel:synthesize-plans",
  reportingRefresh: "reporting:refresh-materialized",
} as const;

const ZERO_TOKENS = {
  maxFastTokensPerRun: 0,
  maxStrategicTokensPerRun: 0,
  cooldownMinutes: 0,
} as const;

export function registerIntelligenceHandlers(scheduler: Scheduler): void {
  // The rollout gate, applied at REGISTRATION rather than inside each handler.
  // A job that must not run in this mode is registered `enabled: false`, so the
  // scheduler never creates its queue or its repeatable cron — it cannot fire and
  // then decline. The in-handler gates (runner, lifecycle) still exist for the
  // manual-trigger path, which bypasses cron entirely.
  //
  // `reporting:refresh-materialized` is deliberately NOT gated: the reporting
  // plane stands on its own, serves the operator dashboard, and must keep its
  // snapshots current whether or not the bot is reasoning. Gating it on the
  // intelligence mode would mean turning the plane off silently staled every
  // report in the product.
  const config = getConfig();
  const capabilities = resolveCapabilities({
    mode: config.INTELLIGENCE_MODE,
    llmPlanningEnabled: config.INTELLIGENCE_LLM_PLANNING_ENABLED,
    allowOutreachRouting: config.INTELLIGENCE_ALLOW_OUTREACH_ROUTING,
    allowSiteMutation: config.INTELLIGENCE_ALLOW_SITE_MUTATION,
  });

  logger.info(
    {
      mode: capabilities.mode,
      propose: capabilities.propose,
      route: capabilities.route,
      llmPlanning: capabilities.llmPlanning,
      outreach: capabilities.outreach,
      siteMutation: capabilities.siteMutation,
    },
    "Intelligence plane rollout capabilities resolved",
  );

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
    enabled: capabilities.reason,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.outcomeAttribution,
    module: "intelligence",
    cron: "0 4 * * *",
    handler: "measureOutcomes",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: capabilities.reason,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.policyRefresh,
    module: "intelligence",
    cron: "0 */4 * * *",
    handler: "refreshPolicyState",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: capabilities.reason,
  });

  // Hourly, not daily. An operator who approves a CRITICAL action at 09:00
  // should not wait until the next overnight pass for its measurement window to
  // open — the baseline is anchored to the approval instant either way, but the
  // follow-up job that gathers the "after" data would sit unqueued all day.
  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.lifecycleSweep,
    module: "intelligence",
    cron: "20 * * * *",
    handler: "sweepLifecycle",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: capabilities.propose,
  });

  // Weekly, and after the 6-hourly materialized refresh has had a turn — the
  // benchmark plane is a snapshot, so recording a run against a snapshot that
  // has not been rebuilt since last week would date the record, not the data.
  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.portfolioBenchmark,
    module: "intelligence",
    cron: "45 7 * * 1",
    handler: "runPortfolioBenchmark",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    enabled: capabilities.reason,
  });

  // The plane's ONE token-spending job, and the only definition here with a
  // non-zero budget. It ranks the remedies for proposals a human is about to
  // decide on; everything else in this module is deterministic arithmetic.
  //
  // 08:15 — after the 07:30 triage has produced the day's proposals, so a
  // decision waits minutes for its options rather than a day. The cooldown
  // bounds how often the sweep may reach a model at all, on top of the
  // per-sweep batch size.
  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.planSynthesis,
    module: "intelligence",
    cron: "15 8 * * *",
    handler: "synthesizePlans",
    clientScoped: false,
    tokenBudget: {
      maxFastTokensPerRun: 0,
      maxStrategicTokensPerRun: 12_000,
      cooldownMinutes: 60,
    },
    enabled: capabilities.llmPlanning,
  });

  scheduler.registerDefinition({
    name: INTELLIGENCE_JOBS.reportingRefresh,
    module: "reporting",
    cron: "15 */6 * * *",
    handler: "refreshMaterializedViews",
    clientScoped: false,
    tokenBudget: { ...ZERO_TOKENS },
    // Not gated on INTELLIGENCE_MODE — the reporting plane is independent.
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

  scheduler.registerHandler(INTELLIGENCE_JOBS.lifecycleSweep, async () => {
    const pickups = await sweepApprovedActions(scheduler);
    // Expiry is a bounded, idempotent UPDATE, so running it beside the pickup
    // costs nothing and keeps the whole lifecycle in one place rather than
    // splitting it across two jobs with two failure modes.
    const expired = await expireStaleOpportunities();
    logger.info(
      { approvedPickups: pickups.length, expiredOpportunities: expired },
      "Lifecycle sweep completed",
    );
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.portfolioBenchmark, async () => {
    const summary = await runPortfolioBenchmark("cron");
    logger.info(summary, "Portfolio benchmark recorded");
  });

  scheduler.registerHandler(INTELLIGENCE_JOBS.planSynthesis, async () => {
    const outcomes = await synthesizePendingProposals(
      getConfig().INTELLIGENCE_SYNTHESIS_BATCH_SIZE,
    );
    logger.info(
      {
        considered: outcomes.length,
        ranked: outcomes.filter((outcome) => outcome.optionCount > 0).length,
      },
      "Plan synthesis completed",
    );
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

  // Fail at registration, not at 02:20 on the first night the two values cross.
  assertLifecycleConfig(getConfig());

  logger.info("Intelligence plane handlers registered");
}
