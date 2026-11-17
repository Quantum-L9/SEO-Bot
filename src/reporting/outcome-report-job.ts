/* L9_META
 * layer: reporting
 * role: client_outcome_report_job
 * status: active
 * version: 1.0.0
 */

/**
 * Weekly outcome-report job. Monday 07:00 UTC — after the overnight ranking
 * (06:00) and engagement (05:00) collection — it snapshots the closed ISO week
 * for every active client (scheduler fan-out). Deterministic: zero tokens.
 * Idempotent: a retried run for the same week writes nothing.
 */

import type { Job } from "bullmq";
import { createModuleLogger } from "../core/logger.js";
import type { Scheduler } from "../core/scheduler.js";
import { previousWeekPeriod } from "./outcome-report.js";
import { persistOutcomeSnapshot } from "./outcome-report-data.js";

const logger = createModuleLogger("reporting:outcome-job");

export const OUTCOME_REPORT_JOB = "reports:outcome-weekly";

export async function runOutcomeReportJob(
  job: Pick<Job, "data">,
  now: () => Date = () => new Date(),
  persist: typeof persistOutcomeSnapshot = persistOutcomeSnapshot,
): Promise<void> {
  const clientId = job.data?.clientId;
  if (typeof clientId !== "string" || !clientId) return;
  const at = now();
  const period = previousWeekPeriod(at);
  const result = await persist(clientId, period, at);
  logger.info(
    { clientId, periodFrom: period.from.toISOString(), created: result.created },
    result.created ? "Weekly outcome report stored" : "Weekly outcome report already stored",
  );
}

export function registerOutcomeReportHandlers(scheduler: Scheduler): void {
  scheduler.registerDefinition({
    name: OUTCOME_REPORT_JOB,
    module: "serp-intelligence",
    cron: "0 7 * * 1",
    handler: "runOutcomeReportJob",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  });
  scheduler.registerHandler(OUTCOME_REPORT_JOB, (job) => runOutcomeReportJob(job));
}
