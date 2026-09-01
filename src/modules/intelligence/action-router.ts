/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Action Router
 *
 * Where intelligence becomes behavior. Everything upstream writes rows; this is
 * the first component that causes work to happen.
 *
 * IT ROUTES THROUGH BULLMQ. IT IS NOT AN EXECUTOR.
 * The router's only effect on the outside world is `scheduler.addJob` plus an
 * action_log row. It never calls DataForSEO, never sends mail, never touches
 * GitHub. That keeps every existing guarantee - token budgets, per-client
 * fan-out, job_executions logging, the circuit breaker - applying to
 * intelligence-originated work exactly as it does to cron-originated work. A
 * parallel async executor here would silently opt out of all of them.
 *
 * ROUTING IS IDEMPOTENT BY CONSTRUCTION.
 * Two independent mechanisms, because the consequences are irreversible:
 *
 *   1. A deterministic BullMQ job id (`routedJobId`) derived from the
 *      opportunity fingerprint. BullMQ drops a re-add of an existing id, so a
 *      retried handler cannot enqueue the same downstream job twice.
 *   2. A UNIQUE (client_id, opportunity_id, job_name) row in
 *      intelligence_action_links, inserted with ON CONFLICT DO NOTHING. Even if
 *      Redis were flushed between attempts, the DB refuses the second link.
 *
 * Belt and braces is warranted: the failure this prevents is sending the same
 * outreach email to a stranger twice.
 */

import { createHash } from "node:crypto";
import { createProposal, evaluateExecution, logAction } from "../../core/execution-policy.js";
import { createModuleLogger } from "../../core/logger.js";
import type { ScoredOpportunity } from "./opportunity-scorer.js";
import type { PolicyGateDecision } from "./policy-gate.js";

const logger = createModuleLogger("intelligence:router");

/** Minimal scheduler surface the router needs - lets tests pass a fake. */
export interface RoutableScheduler {
  addJob(jobName: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<void>;
}

/**
 * Downstream jobs each opportunity type may route to.
 *
 * Every job named here is READ-ONLY analysis except `links:process-outreach`,
 * which is gated separately by `routesOutreach`. `serp:execute-surpass-plans`
 * is deliberately absent: it mutates live sites, is disabled in the scheduler
 * registry, and intelligence must not be the thing that turns it on. Site
 * changes go through `intelligence_request_site_fix` into the existing
 * plan-executor approval path instead.
 */
export const ROUTE_MAP: Record<
  string,
  ReadonlyArray<{ jobName: string; action: string; outreach?: boolean }>
> = {
  recover_keyword_ranking: [
    { jobName: "serp:competitor-analysis", action: "intelligence_run_competitor_analysis" },
    { jobName: "serp:generate-surpass-plan", action: "intelligence_generate_surpass_plan" },
  ],
  fix_slow_exit_page: [
    { jobName: "vitals:check-all-sources", action: "intelligence_run_competitor_analysis" },
    { jobName: "", action: "intelligence_request_site_fix" },
  ],
  recover_citation: [
    { jobName: "aeo:check-citations", action: "intelligence_run_competitor_analysis" },
    { jobName: "aeo:optimize-faqs", action: "intelligence_optimize_faq_draft" },
  ],
  acquire_backlink: [
    { jobName: "links:process-outreach", action: "intelligence_queue_outreach", outreach: true },
  ],
};

/**
 * Deterministic BullMQ job id for an intelligence-routed job.
 *
 * Keyed on the opportunity fingerprint rather than a timestamp or a run id:
 * the same opportunity routing to the same job is the same unit of work, no
 * matter which run noticed it. A run-scoped key would let every run re-enqueue
 * the same outreach.
 */
export function routedJobId(
  clientId: string,
  opportunityFingerprint: string,
  jobName: string,
): string {
  const digest = createHash("sha256")
    .update(`${clientId}|${opportunityFingerprint}|${jobName}`)
    .digest("hex")
    .slice(0, 32);
  return `intel:${digest}`;
}

export interface RouteResult {
  opportunityFingerprint: string;
  action: string;
  jobName: string | null;
  jobId: string | null;
  actionLogId: string | null;
  outcome: "queued" | "proposed" | "blocked" | "deduped";
  blockedReason: string | null;
}

export interface RouteDeps {
  scheduler: RoutableScheduler;
  /** Records the link; returns false when the unique constraint rejected it. */
  recordLink(link: {
    clientId: string;
    opportunityId: string;
    jobName: string | null;
    jobId: string | null;
    actionLogId: string | null;
    action: string;
    outcome: string;
    blockedReason: string | null;
  }): Promise<boolean>;
  /** Policy gate, injected so the router is testable without config. */
  evaluate(action: string, outreach: boolean): PolicyGateDecision;
  /** Client row data attached to every queued job, matching existing handlers. */
  clientDomain: string;
  clientConfig: unknown;
  /** True when proposals may be written (mode >= recommend). */
  writesProposals: boolean;
}

/**
 * Route one opportunity.
 *
 * Order matters: the policy gate runs BEFORE the proposal is created and before
 * anything is enqueued. A blocked action still records a link row with its
 * reason, so "the loop considered this and declined" is visible in the audit
 * trail rather than being indistinguishable from "the loop never looked".
 */
export async function routeOpportunity(
  opportunity: ScoredOpportunity & { id: string },
  deps: RouteDeps,
): Promise<RouteResult[]> {
  const routes = ROUTE_MAP[opportunity.opportunityType] ?? [];
  const results: RouteResult[] = [];

  for (const route of routes) {
    const decision = deps.evaluate(route.action, route.outreach === true);

    if (!decision.allowed) {
      const reason = decision.reasons.join("; ");
      await deps.recordLink({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId: null,
        action: route.action,
        outcome: "blocked",
        blockedReason: reason,
      });
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId: null,
        outcome: "blocked",
        blockedReason: reason,
      });
      continue;
    }

    // Proposal first: the action_log row is the operator-visible record, and it
    // must exist whether or not a downstream job is enqueued.
    let actionLogId: string | null = null;
    if (deps.writesProposals) {
      const proposal = createProposal({
        clientId: opportunity.clientId,
        module: "intelligence",
        action: route.action,
        description: `Intelligence routed ${route.action} for ${opportunity.opportunityType}`,
        rationale: opportunity.rationale,
        triggeredBy: `intelligence:opportunity:${opportunity.fingerprint.slice(0, 12)}`,
        estimatedImpact: String(opportunity.impact),
        metadata: {
          opportunityType: opportunity.opportunityType,
          score: opportunity.score,
          signalFingerprints: opportunity.signalFingerprints,
        },
      });
      const executionDecision = evaluateExecution(proposal);
      actionLogId = await logAction(proposal, executionDecision);

      // The proposal-level gate is independent of the policy gate above: a
      // critical action reaching here is still held for approval rather than
      // enqueued, no matter what mode says.
      if (!executionDecision.execute) {
        await deps.recordLink({
          clientId: opportunity.clientId,
          opportunityId: opportunity.id,
          jobName: route.jobName || null,
          jobId: null,
          actionLogId,
          action: route.action,
          outcome: "blocked",
          blockedReason: executionDecision.reason,
        });
        results.push({
          opportunityFingerprint: opportunity.fingerprint,
          action: route.action,
          jobName: route.jobName || null,
          jobId: null,
          actionLogId,
          outcome: "blocked",
          blockedReason: executionDecision.reason,
        });
        continue;
      }
    }

    // Proposal-only route (no downstream job).
    if (!route.jobName) {
      await deps.recordLink({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        jobName: null,
        jobId: null,
        actionLogId,
        action: route.action,
        outcome: "proposed",
        blockedReason: null,
      });
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: null,
        jobId: null,
        actionLogId,
        outcome: "proposed",
        blockedReason: null,
      });
      continue;
    }

    const jobId = routedJobId(opportunity.clientId, opportunity.fingerprint, route.jobName);

    // Claim the link BEFORE enqueuing. If the unique constraint rejects it,
    // this opportunity already routed to this job on a previous attempt and we
    // must not enqueue again. Doing it in this order means a crash between the
    // two leaves a link with no job (recoverable, visible) rather than a job
    // with no link (invisible duplicate risk).
    const claimed = await deps.recordLink({
      clientId: opportunity.clientId,
      opportunityId: opportunity.id,
      jobName: route.jobName,
      jobId,
      actionLogId,
      action: route.action,
      outcome: "queued",
      blockedReason: null,
    });

    if (!claimed) {
      logger.debug(
        { clientId: opportunity.clientId, jobName: route.jobName, jobId },
        "Route already claimed - skipping duplicate enqueue",
      );
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: route.jobName,
        jobId,
        actionLogId,
        outcome: "deduped",
        blockedReason: null,
      });
      continue;
    }

    await deps.scheduler.addJob(
      route.jobName,
      {
        clientId: opportunity.clientId,
        clientDomain: deps.clientDomain,
        clientConfig: deps.clientConfig,
        triggeredBy: "intelligence",
        opportunityFingerprint: opportunity.fingerprint,
      },
      { jobId },
    );

    results.push({
      opportunityFingerprint: opportunity.fingerprint,
      action: route.action,
      jobName: route.jobName,
      jobId,
      actionLogId,
      outcome: "queued",
      blockedReason: null,
    });
  }

  return results;
}
