/* L9_META
 * layer: api
 * role: website_handoff_monitoring_enrollment
 * status: active
 * version: 1.0.0
 */

/**
 * Monitoring enrollment for a Website-Bot handoff.
 *
 * An active client is picked up by every client-scoped cron fan-out, so the
 * recurring schedule needs no per-client registration. What it does not give
 * is a *baseline*: a site handed off on a Thursday would otherwise wait until
 * the next Wednesday for its first AI-citation check. On a verified handoff
 * we therefore queue one immediate run of each zero/low-token monitoring job.
 *
 * Idempotency: the BullMQ job id is derived from (job, client, contract
 * digest). A Website-Bot retry of the same handoff re-queues nothing; a new
 * release (new digest) earns a fresh baseline. Enqueue is fail-open per job —
 * the client is already active, so the cron schedule still covers it.
 */

import { deterministicJobId } from "../../core/job-id.js";

/** Monitoring-only jobs; none mutates the site or sends outreach. */
export const BASELINE_MONITORING_JOBS = [
  "serp:check-rankings",
  "vitals:check-all-sources",
  "aeo:check-citations",
  "behavior:pull-engagement",
] as const;

export type BaselineMonitoringJob = (typeof BASELINE_MONITORING_JOBS)[number];

export type EnqueueMonitoringJob = (
  jobName: string,
  data: Record<string, unknown>,
  opts: { jobId: string },
) => Promise<void>;

export interface MonitoringEnrollmentInput {
  clientId: string;
  clientDomain: string;
  clientConfig: Record<string, unknown>;
  contractDigest: string;
}

export interface MonitoringEnrollmentResult {
  queued: Array<{ job: BaselineMonitoringJob; jobId: string }>;
  failed: Array<{ job: BaselineMonitoringJob; jobId: string; error: string }>;
}

export function baselineJobId(jobName: string, clientId: string, contractDigest: string): string {
  // The digest may be prefixed ("sha256:…"); keep only its hex body, bounded.
  const digest = contractDigest.replace(/^[a-z0-9]+:/i, "").slice(0, 32);
  return deterministicJobId("baseline", jobName, clientId, digest);
}

export async function enrollClientMonitoring(
  input: MonitoringEnrollmentInput,
  enqueue: EnqueueMonitoringJob,
): Promise<MonitoringEnrollmentResult> {
  const result: MonitoringEnrollmentResult = { queued: [], failed: [] };
  for (const job of BASELINE_MONITORING_JOBS) {
    const jobId = baselineJobId(job, input.clientId, input.contractDigest);
    try {
      await enqueue(
        job,
        {
          clientId: input.clientId,
          clientDomain: input.clientDomain,
          clientConfig: input.clientConfig,
        },
        { jobId },
      );
      result.queued.push({ job, jobId });
    } catch (error) {
      result.failed.push({
        job,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
