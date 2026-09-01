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
 * which the policy gate holds against the link-velocity governor and the
 * ranking circuit breaker. `serp:execute-surpass-plans` is deliberately absent:
 * it mutates live sites, ships disabled in the scheduler registry, and
 * intelligence must never be the thing that turns it on. Site changes reach it
 * only through `intelligence_request_site_fix`, which files a proposal a human
 * approves.
 */
export const ROUTE_MAP: Record<
  string,
  ReadonlyArray<{ jobName: string; action: string; outreach?: boolean }>
> = {
  content_refresh: [
    { jobName: "serp:competitor-analysis", action: "intelligence_run_competitor_analysis" },
    { jobName: "serp:generate-surpass-plan", action: "intelligence_generate_surpass_plan" },
  ],
  technical_seo_fix: [
    { jobName: "vitals:check-all-sources", action: "intelligence_run_competitor_analysis" },
    // Proposal only: the fix itself is a site change, which a human approves.
    { jobName: "", action: "intelligence_request_site_fix" },
  ],
  aeo_answer_block: [
    { jobName: "aeo:check-citations", action: "intelligence_run_competitor_analysis" },
    { jobName: "aeo:optimize-faqs", action: "intelligence_optimize_faq" },
  ],
  link_building: [
    { jobName: "links:process-outreach", action: "intelligence_queue_outreach", outreach: true },
  ],
  // The loop cannot fix its own spend or its own plumbing. Both escalate to a
  // human rather than routing work — an autonomous retry storm against a
  // failing provider, or more LLM calls when the budget is already strained,
  // makes each situation worse rather than better.
  budget_risk: [{ jobName: "", action: "intelligence_escalate_operator" }],
  job_reliability: [{ jobName: "", action: "intelligence_escalate_operator" }],
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
  decisionId: string | null;
  outcome: "queued" | "proposed" | "blocked" | "deduped" | "pending_approval";
  blockedReason: string | null;
}

export interface RouteDeps {
  scheduler: RoutableScheduler;
  /** Records the link; returns false when the unique constraint rejected it. */
  recordLink(link: {
    clientId: string;
    opportunityId: string;
    decisionId: string | null;
    jobName: string | null;
    jobId: string | null;
    actionLogId: string | null;
    action: string;
    status: string;
    blockedReason: string | null;
  }): Promise<boolean>;
  /** Policy gate, injected so the router is testable without config. */
  evaluate(action: string, outreach: boolean): PolicyGateDecision;
  /**
   * Records why the loop acted or declined, returning the decision row id.
   * Called for EVERY route, allowed or blocked: "considered and declined" must
   * be distinguishable from "never looked".
   */
  recordDecision(entry: {
    clientId: string;
    opportunityId: string;
    decisionType: string;
    decision: "act" | "defer" | "escalate";
    rationale: string;
    policyBasis: Record<string, unknown>;
    evidenceSummary: Record<string, unknown>;
    requiresApproval: boolean;
    actionLogId: string | null;
  }): Promise<string | null>;
  /** Client row data attached to every queued job, matching existing handlers. */
  clientDomain: string;
  clientConfig: unknown;
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

  const evidenceSummary: Record<string, unknown> = {
    opportunityType: opportunity.opportunityType,
    score: opportunity.score,
    expectedImpact: opportunity.expectedImpact,
    confidence: opportunity.confidence,
    urgency: opportunity.urgency,
    signalFingerprints: opportunity.signalFingerprints,
  };

  for (const route of routes) {
    const decision = deps.evaluate(route.action, route.outreach === true);

    // ── Blocked ────────────────────────────────────────────────────────────
    if (!decision.allowed) {
      const reason = decision.reasons.join("; ");
      const decisionId = await deps.recordDecision({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        decisionType: route.action,
        decision: "defer",
        rationale: reason,
        policyBasis: decision.policyBasis,
        evidenceSummary,
        requiresApproval: decision.requiresApproval,
        actionLogId: null,
      });
      await deps.recordLink({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        decisionId,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId: null,
        action: route.action,
        status: "blocked",
        blockedReason: reason,
      });
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId: null,
        decisionId,
        outcome: "blocked",
        blockedReason: reason,
      });
      continue;
    }

    // ── Proposal ───────────────────────────────────────────────────────────
    // The action_log row is the operator-visible record and is written whether
    // or not a downstream job follows.
    const proposal = createProposal({
      clientId: opportunity.clientId,
      module: "intelligence",
      action: route.action,
      description: `${opportunity.title} (${opportunity.opportunityType})`,
      rationale: opportunity.rationale,
      triggeredBy: `intelligence:opportunity:${opportunity.fingerprint.slice(0, 12)}`,
      estimatedImpact: String(opportunity.expectedImpact),
      metadata: {
        opportunityType: opportunity.opportunityType,
        score: opportunity.score,
        targetUrl: opportunity.targetUrl,
        targetKeyword: opportunity.targetKeyword,
        signalFingerprints: opportunity.signalFingerprints,
      },
    });
    const executionDecision = evaluateExecution(proposal);
    const actionLogId = await logAction(proposal, executionDecision);

    // The proposal-level gate is independent of the policy gate above: a
    // critical action reaching here is still held for approval, whatever the
    // configuration said.
    if (!executionDecision.execute) {
      const decisionId = await deps.recordDecision({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        decisionType: route.action,
        decision: "escalate",
        rationale: executionDecision.reason,
        policyBasis: decision.policyBasis,
        evidenceSummary,
        requiresApproval: true,
        actionLogId,
      });
      await deps.recordLink({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        decisionId,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId,
        action: route.action,
        status: "pending_approval",
        blockedReason: executionDecision.reason,
      });
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: route.jobName || null,
        jobId: null,
        actionLogId,
        decisionId,
        outcome: "pending_approval",
        blockedReason: executionDecision.reason,
      });
      continue;
    }

    const decisionId = await deps.recordDecision({
      clientId: opportunity.clientId,
      opportunityId: opportunity.id,
      decisionType: route.action,
      decision: "act",
      rationale: opportunity.rationale,
      policyBasis: decision.policyBasis,
      evidenceSummary,
      requiresApproval: false,
      actionLogId,
    });

    // ── Proposal-only route (no downstream job) ────────────────────────────
    if (!route.jobName) {
      await deps.recordLink({
        clientId: opportunity.clientId,
        opportunityId: opportunity.id,
        decisionId,
        jobName: null,
        jobId: null,
        actionLogId,
        action: route.action,
        status: "proposed",
        blockedReason: null,
      });
      results.push({
        opportunityFingerprint: opportunity.fingerprint,
        action: route.action,
        jobName: null,
        jobId: null,
        actionLogId,
        decisionId,
        outcome: "proposed",
        blockedReason: null,
      });
      continue;
    }

    // ── Queue ──────────────────────────────────────────────────────────────
    const jobId = routedJobId(opportunity.clientId, opportunity.fingerprint, route.jobName);

    // Claim the link BEFORE enqueuing. If the unique constraint rejects it,
    // this opportunity already routed to this job on a previous attempt and we
    // must not enqueue again. Doing it in this order means a crash between the
    // two leaves a link with no job (recoverable, visible) rather than a job
    // with no link (an invisible duplicate risk).
    const claimed = await deps.recordLink({
      clientId: opportunity.clientId,
      opportunityId: opportunity.id,
      decisionId,
      jobName: route.jobName,
      jobId,
      actionLogId,
      action: route.action,
      status: "queued",
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
        decisionId,
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
        opportunityId: opportunity.id,
        opportunityFingerprint: opportunity.fingerprint,
        targetUrl: opportunity.targetUrl,
        targetKeyword: opportunity.targetKeyword,
        reason: opportunity.rationale,
      },
      { jobId },
    );

    results.push({
      opportunityFingerprint: opportunity.fingerprint,
      action: route.action,
      jobName: route.jobName,
      jobId,
      actionLogId,
      decisionId,
      outcome: "queued",
      blockedReason: null,
    });
  }

  return results;
}
