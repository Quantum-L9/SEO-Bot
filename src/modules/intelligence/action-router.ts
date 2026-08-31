/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: action router
 *
 * Where intelligence becomes behavior — and therefore the file to read first
 * when asking what the loop can actually DO.
 *
 * Three properties are load-bearing:
 *
 *  1. IT NEVER EXECUTES. The router enqueues BullMQ jobs owned by the producer
 *     modules and writes rows. There is no second execution path: no direct
 *     HTTP call, no site write, no email. Everything the loop causes is
 *     something an existing, separately-tested job already knew how to do.
 *
 *  2. THE JOB ALLOW-LIST IS CLOSED. A job name not in SAFE_JOBS or
 *     OUTREACH_JOBS cannot be enqueued from here at all, whatever an
 *     opportunity or a planner asked for. `serp:execute-surpass-plans` — the
 *     one job that writes to a live site — is absent by construction and named
 *     in FORBIDDEN_JOBS so its absence is asserted rather than assumed.
 *
 *  3. ROUTING IS IDEMPOTENT. The BullMQ job id and the action-link row are both
 *     derived from (client, opportunity, job). BullMQ drops the duplicate add
 *     and the unique index drops the duplicate link, so a re-delivered job
 *     produces one queued job and one link — the property that stops an
 *     at-least-once queue from sending an outreach email twice.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import {
  createProposal,
  evaluateExecution,
  INTELLIGENCE_MODULE,
  logAction,
} from "../../core/execution-policy.js";
import { createModuleLogger } from "../../core/logger.js";
import { routedJobId } from "./fingerprint.js";
import { assertClientId, type Capability, currentMode, evaluateGate } from "./policy-gate.js";
import type { JobSink, OpportunityType, PlannedAction, RoutedJob } from "./types.js";

const logger = createModuleLogger("intelligence:router");

/**
 * Read-only analysis jobs. Each gathers or drafts; none mutates a live site and
 * none contacts anyone outside the system.
 */
export const SAFE_JOBS = Object.freeze([
  "serp:competitor-analysis",
  "serp:generate-surpass-plan",
  "vitals:check-all-sources",
  "aeo:check-citations",
  "aeo:optimize-faqs",
  "behavior:generate-insights",
]);

/** Jobs that send mail. Reachable only via the `route_outreach` capability. */
export const OUTREACH_JOBS = Object.freeze(["links:process-outreach"]);

/**
 * Jobs the router must never enqueue under ANY mode.
 *
 * `serp:execute-surpass-plans` writes to a live site. The loop can ask for a
 * plan to be generated; turning a plan into a commit stays an operator
 * decision, made by flipping that job's own `enabled` flag. Listed explicitly
 * so a test can assert the exclusion rather than infer it from an absence.
 */
export const FORBIDDEN_JOBS = Object.freeze(["serp:execute-surpass-plans"]);

interface RouteDefinition {
  /** The intelligence action recorded in action_log for this route. */
  action: string;
  /** The capability the policy gate must grant before anything is enqueued. */
  capability: Capability;
  /** Jobs to enqueue, in order. May be empty for a proposal-only route. */
  jobs: readonly string[];
}

/**
 * Opportunity type → what to do about it.
 *
 * The opportunity types map one-to-one onto the signal types they came from
 * (keyword_drop, bad_lcp_high_exit, citation_loss, prospect_ready), so this is
 * the signal→job routing table stated at the level the scorer works in.
 */
const ROUTE_MAP: Record<OpportunityType, RouteDefinition> = {
  recover_keyword_position: {
    action: "intelligence_generate_surpass_plan",
    capability: "route_safe_job",
    jobs: ["serp:competitor-analysis", "serp:generate-surpass-plan"],
  },
  fix_page_experience: {
    action: "intelligence_request_site_fix",
    capability: "route_safe_job",
    // Re-measure across every source first. The fix itself is a proposal on
    // action_log for a human or a separately-enabled job to pick up — the loop
    // does not edit the page.
    jobs: ["vitals:check-all-sources"],
  },
  regain_answer_citation: {
    action: "intelligence_optimize_faq_draft",
    capability: "route_safe_job",
    jobs: ["aeo:check-citations", "aeo:optimize-faqs"],
  },
  pursue_link_prospect: {
    action: "intelligence_queue_outreach",
    capability: "route_outreach",
    jobs: ["links:process-outreach"],
  },
};

/** The action each opportunity type proposes deterministically, without an LLM. */
export function deterministicActionFor(opportunityType: OpportunityType): string | undefined {
  return ROUTE_MAP[opportunityType]?.action;
}

/**
 * Guard the allow-list at the point of enqueue.
 *
 * Deliberately re-checked here rather than trusted from ROUTE_MAP: this is the
 * last line before BullMQ, and it is the line that must still hold if someone
 * later adds a route entry without thinking about what it can reach.
 */
export function isRoutableJob(jobName: string): boolean {
  if (FORBIDDEN_JOBS.includes(jobName)) return false;
  return SAFE_JOBS.includes(jobName) || OUTREACH_JOBS.includes(jobName);
}

export interface RoutingOutcome {
  opportunityId: string;
  opportunityFingerprint: string;
  action: string;
  /** routed when jobs were enqueued, proposed when recorded only, blocked otherwise. */
  decision: "routed" | "proposed" | "blocked";
  blockedReason?: string;
  routedJobs: RoutedJob[];
  actionLogId?: string;
}

/**
 * Route one planned action.
 *
 * Returns an outcome for every input — including refusals — because a blocked
 * decision is evidence that has to reach `intelligence_decisions`. Silently
 * dropping a refusal would make the audit query in the runbook read as though
 * the loop never considered the action at all.
 */
export async function routePlannedAction(params: {
  planned: PlannedAction;
  sink: JobSink;
  clientConfig?: Record<string, unknown>;
  runId?: string;
}): Promise<RoutingOutcome> {
  const { planned, sink, clientConfig, runId } = params;
  const { clientId } = planned;
  assertClientId(clientId);

  const db = getDb();
  const mode = currentMode();

  const [opportunity] = await db
    .select({
      id: schema.intelligenceOpportunities.id,
      opportunityType: schema.intelligenceOpportunities.opportunityType,
      score: schema.intelligenceOpportunities.score,
      rationale: schema.intelligenceOpportunities.rationale,
    })
    .from(schema.intelligenceOpportunities)
    .where(
      and(
        // Scoped by client as well as fingerprint: a fingerprint is only
        // unique WITHIN a client, so looking one up without the client id
        // would be the cross-tenant read this module exists to prevent.
        eq(schema.intelligenceOpportunities.clientId, clientId),
        eq(schema.intelligenceOpportunities.fingerprint, planned.opportunityFingerprint),
      ),
    )
    .limit(1);

  if (!opportunity) {
    return {
      opportunityId: "",
      opportunityFingerprint: planned.opportunityFingerprint,
      action: planned.action,
      decision: "blocked",
      blockedReason: "opportunity not found for this client",
      routedJobs: [],
    };
  }

  const route = ROUTE_MAP[opportunity.opportunityType as OpportunityType];
  if (!route) {
    return {
      opportunityId: opportunity.id,
      opportunityFingerprint: planned.opportunityFingerprint,
      action: planned.action,
      decision: "blocked",
      blockedReason: `no route defined for opportunity type ${opportunity.opportunityType}`,
      routedJobs: [],
    };
  }

  // Record the proposal on action_log FIRST. `createProposal` classifies it
  // against the intelligence module's closed vocabulary, so an action outside
  // that vocabulary lands as critical/pending_approval and is refused below —
  // this is the fail-closed seam, reached before anything is enqueued.
  const proposal = createProposal({
    clientId,
    module: INTELLIGENCE_MODULE,
    action: planned.action,
    description: `Route ${opportunity.opportunityType} (score ${opportunity.score})`,
    rationale: planned.rationale,
    triggeredBy: `intelligence:${planned.source}:${planned.opportunityFingerprint}`,
    metadata: { mode, opportunityFingerprint: planned.opportunityFingerprint },
  });
  const executionDecision = evaluateExecution(proposal);
  const actionLogId = await logAction(proposal, executionDecision);

  if (!executionDecision.execute) {
    await recordDecision({
      clientId,
      runId,
      opportunityId: opportunity.id,
      mode,
      source: planned.source,
      action: planned.action,
      decision: "blocked",
      blockedReason: executionDecision.reason,
      actionLogId,
    });
    logger.warn({ clientId, action: planned.action }, "action held for approval — nothing routed");
    return {
      opportunityId: opportunity.id,
      opportunityFingerprint: planned.opportunityFingerprint,
      action: planned.action,
      decision: "blocked",
      blockedReason: executionDecision.reason,
      routedJobs: [],
      actionLogId,
    };
  }

  const gate = await evaluateGate({ capability: route.capability, clientId, clientConfig });
  if (!gate.allowed) {
    await recordDecision({
      clientId,
      runId,
      opportunityId: opportunity.id,
      mode,
      source: planned.source,
      action: planned.action,
      decision: "blocked",
      blockedReason: `${gate.gate}: ${gate.reason}`,
      actionLogId,
    });
    return {
      opportunityId: opportunity.id,
      opportunityFingerprint: planned.opportunityFingerprint,
      action: planned.action,
      decision: "blocked",
      blockedReason: `${gate.gate}: ${gate.reason}`,
      routedJobs: [],
      actionLogId,
    };
  }

  const routed: RoutedJob[] = [];
  for (const jobName of route.jobs) {
    if (!isRoutableJob(jobName)) {
      logger.error({ jobName }, "route referenced a job outside the allow-list — refusing");
      continue;
    }
    const jobId = routedJobId(clientId, planned.opportunityFingerprint, jobName);

    // Claim the link BEFORE enqueuing. The unique index is the arbiter: if a
    // concurrent or re-delivered run already claimed this route, the insert
    // reports no row and we skip the enqueue entirely. Enqueuing first and
    // linking after would leave a window where a crash produces a queued job
    // with no link — invisible to the duplicate-routing audit.
    const claimed = await db
      .insert(schema.intelligenceActionLinks)
      .values({
        clientId,
        opportunityId: opportunity.id,
        jobName,
        jobId,
        actionLogId,
      })
      .onConflictDoNothing({
        target: [
          schema.intelligenceActionLinks.clientId,
          schema.intelligenceActionLinks.opportunityId,
          schema.intelligenceActionLinks.jobName,
        ],
      })
      .returning({ id: schema.intelligenceActionLinks.id });

    if (claimed.length === 0) {
      logger.info({ clientId, jobName }, "route already claimed — not re-enqueuing");
      continue;
    }

    await sink.addJob(jobName, { clientId, clientConfig, triggeredBy: "intelligence" }, { jobId });
    routed.push({ jobName, jobId });
  }

  await db
    .update(schema.intelligenceOpportunities)
    .set({ status: "routed", updatedAt: new Date() })
    .where(
      and(
        eq(schema.intelligenceOpportunities.clientId, clientId),
        eq(schema.intelligenceOpportunities.id, opportunity.id),
      ),
    );

  await recordDecision({
    clientId,
    runId,
    opportunityId: opportunity.id,
    mode,
    source: planned.source,
    action: planned.action,
    decision: routed.length > 0 ? "routed" : "proposed",
    actionLogId,
  });

  return {
    opportunityId: opportunity.id,
    opportunityFingerprint: planned.opportunityFingerprint,
    action: planned.action,
    decision: routed.length > 0 ? "routed" : "proposed",
    routedJobs: routed,
    actionLogId,
  };
}

async function recordDecision(params: {
  clientId: string;
  runId?: string;
  opportunityId: string;
  mode: string;
  source: string;
  action: string;
  decision: string;
  blockedReason?: string;
  actionLogId?: string;
}): Promise<void> {
  const db = getDb();
  await db.insert(schema.intelligenceDecisions).values({
    clientId: params.clientId,
    runId: params.runId ?? null,
    opportunityId: params.opportunityId || null,
    mode: params.mode,
    source: params.source,
    proposedAction: params.action,
    decision: params.decision,
    blockedReason: params.blockedReason ?? null,
    actionLogId: params.actionLogId ?? null,
  });
}
