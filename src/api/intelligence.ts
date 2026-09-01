/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Operator API
 *
 * Routes:
 *   GET /api/clients/:clientId/intelligence   signals + run history
 *   GET /api/clients/:clientId/opportunities  scored opportunities + routing
 *   GET /api/intelligence/portfolio           anonymized cross-client rollup
 *
 * TWO THINGS THIS FILE IS RESPONSIBLE FOR.
 *
 * 1. TENANT SCOPING. Every per-client query filters on the path clientId, and
 *    the client row is loaded first so an unknown id 404s rather than returning
 *    an empty list that looks like "this client has no signals".
 *
 * 2. NO SECRET EGRESS. Rows are projected through an explicit field list, never
 *    spread. `clients` carries `posthogApiKey` and a free-form `config` blob;
 *    `SELECT *` plus `return rows` is exactly how those reach an operator's
 *    browser. Listing the fields means a column added later is omitted by
 *    default rather than published by default.
 *
 * The portfolio route is the ONE place a query is not client-scoped. It exists
 * for benchmarking, so it returns counts and medians only - never a client id,
 * domain, keyword, or URL. Anonymization is by construction (aggregate SQL),
 * not by stripping fields from rows that were already read.
 */

import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import { currentCapabilities } from "../modules/intelligence/capabilities.js";

const logger = createModuleLogger("api:intelligence");

/** Max rows any single intelligence route will return. */
const PAGE_LIMIT = 200;

/**
 * Minimum distinct clients before a portfolio aggregate is returned.
 *
 * With one or two tenants an "anonymous" median is trivially re-identifiable by
 * whoever owns them. Below the threshold the route reports the count and
 * withholds the statistics.
 */
const PORTFOLIO_MIN_CLIENTS = 3;

/**
 * Intelligence phases an operator may trigger by hand.
 *
 * Deliberately NOT derived from the scheduler registry: a new job should not
 * become externally reachable merely by existing. `serp:execute-surpass-plans`
 * is absent from every trigger surface in this repo for the same reason.
 */
const TRIGGERABLE_PHASES: readonly string[] = [
  "intelligence:extract-signals",
  "intelligence:score-opportunities",
  "intelligence:plan-actions",
  "intelligence:measure-outcomes",
];

export async function registerIntelligenceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/intelligence",
    async (request, reply) => {
      const { clientId } = request.params;
      const db = getDb();

      const [client] = await db
        .select({ id: schema.clients.id, domain: schema.clients.domain })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) return reply.code(404).send({ error: "Client not found" });

      const [signals, runs] = await Promise.all([
        db
          .select({
            signalType: schema.intelligenceSignals.signalType,
            fingerprint: schema.intelligenceSignals.fingerprint,
            entityKey: schema.intelligenceSignals.entityKey,
            severity: schema.intelligenceSignals.severity,
            entityType: schema.intelligenceSignals.entityType,
            confidence: schema.intelligenceSignals.confidence,
            suppressedUntil: schema.intelligenceSignals.suppressedUntil,
            status: schema.intelligenceSignals.status,
            evidence: schema.intelligenceSignals.evidence,
            firstSeenAt: schema.intelligenceSignals.firstSeenAt,
            observedAt: schema.intelligenceSignals.observedAt,
          })
          .from(schema.intelligenceSignals)
          .where(eq(schema.intelligenceSignals.clientId, clientId))
          .orderBy(desc(schema.intelligenceSignals.observedAt))
          .limit(PAGE_LIMIT),
        db
          .select({
            runType: schema.intelligenceRuns.runType,
            triggerSource: schema.intelligenceRuns.triggerSource,
            durationMs: schema.intelligenceRuns.durationMs,
            llmUsed: schema.intelligenceRuns.llmUsed,
            status: schema.intelligenceRuns.status,
            error: schema.intelligenceRuns.error,
            metadata: schema.intelligenceRuns.metadata,
            startedAt: schema.intelligenceRuns.startedAt,
            completedAt: schema.intelligenceRuns.completedAt,
          })
          .from(schema.intelligenceRuns)
          .where(eq(schema.intelligenceRuns.clientId, clientId))
          .orderBy(desc(schema.intelligenceRuns.startedAt))
          .limit(50),
      ]);

      return {
        clientId: client.id,
        domain: client.domain,
        capabilities: currentCapabilities(),
        signals,
        runs,
      };
    },
  );

  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/opportunities",
    async (request, reply) => {
      const { clientId } = request.params;
      const db = getDb();

      const [client] = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) return reply.code(404).send({ error: "Client not found" });

      const opportunities = await db
        .select({
          id: schema.intelligenceOpportunities.id,
          opportunityType: schema.intelligenceOpportunities.opportunityType,
          fingerprint: schema.intelligenceOpportunities.fingerprint,
          title: schema.intelligenceOpportunities.title,
          description: schema.intelligenceOpportunities.description,
          targetUrl: schema.intelligenceOpportunities.targetUrl,
          targetKeyword: schema.intelligenceOpportunities.targetKeyword,
          score: schema.intelligenceOpportunities.score,
          expectedImpact: schema.intelligenceOpportunities.expectedImpact,
          confidence: schema.intelligenceOpportunities.confidence,
          urgency: schema.intelligenceOpportunities.urgency,
          effort: schema.intelligenceOpportunities.effort,
          risk: schema.intelligenceOpportunities.risk,
          status: schema.intelligenceOpportunities.status,
          rationale: schema.intelligenceOpportunities.rationale,
          createdAt: schema.intelligenceOpportunities.createdAt,
          updatedAt: schema.intelligenceOpportunities.updatedAt,
        })
        .from(schema.intelligenceOpportunities)
        .where(eq(schema.intelligenceOpportunities.clientId, clientId))
        .orderBy(desc(schema.intelligenceOpportunities.score))
        .limit(PAGE_LIMIT);

      const links = await db
        .select({
          opportunityId: schema.intelligenceActionLinks.opportunityId,
          action: schema.intelligenceActionLinks.action,
          jobName: schema.intelligenceActionLinks.jobName,
          status: schema.intelligenceActionLinks.status,
          blockedReason: schema.intelligenceActionLinks.blockedReason,
          createdAt: schema.intelligenceActionLinks.createdAt,
        })
        .from(schema.intelligenceActionLinks)
        .where(eq(schema.intelligenceActionLinks.clientId, clientId))
        .orderBy(desc(schema.intelligenceActionLinks.createdAt))
        .limit(PAGE_LIMIT);

      return { clientId: client.id, opportunities, links };
    },
  );

  /**
   * The decision ledger: why the loop acted, or declined to.
   *
   * Deferrals are included, not just actions. "The gate blocked this correctly"
   * and "the loop never looked at it" are different states, and only a ledger
   * that records both lets an operator tell them apart.
   */
  app.get<{ Params: { clientId: string } }>(
    "/api/clients/:clientId/decisions",
    async (request, reply) => {
      const { clientId } = request.params;
      const db = getDb();

      const [client] = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) return reply.code(404).send({ error: "Client not found" });

      const decisions = await db
        .select({
          id: schema.intelligenceDecisions.id,
          opportunityId: schema.intelligenceDecisions.opportunityId,
          decisionType: schema.intelligenceDecisions.decisionType,
          decision: schema.intelligenceDecisions.decision,
          rationale: schema.intelligenceDecisions.rationale,
          policyBasis: schema.intelligenceDecisions.policyBasis,
          evidenceSummary: schema.intelligenceDecisions.evidenceSummary,
          requiresApproval: schema.intelligenceDecisions.requiresApproval,
          actionLogId: schema.intelligenceDecisions.actionLogId,
          createdAt: schema.intelligenceDecisions.createdAt,
        })
        .from(schema.intelligenceDecisions)
        .where(eq(schema.intelligenceDecisions.clientId, clientId))
        .orderBy(desc(schema.intelligenceDecisions.createdAt))
        .limit(PAGE_LIMIT);

      return { clientId: client.id, decisions };
    },
  );

  /**
   * Manual trigger for one intelligence phase.
   *
   * Separate from the generic /trigger route so the allow-list here can be the
   * intelligence job names only — an operator cannot reach another module's
   * jobs through this path, and a new intelligence job is not automatically
   * exposed by adding it to the scheduler.
   */
  app.post<{ Params: { clientId: string }; Body: { phase?: string } }>(
    "/api/clients/:clientId/intelligence/trigger",
    async (request, reply) => {
      const { clientId } = request.params;
      const { phase } = (request.body ?? {}) as { phase?: string };

      if (!phase || !TRIGGERABLE_PHASES.includes(phase)) {
        return reply
          .code(400)
          .send({ error: `Invalid phase. Valid: ${TRIGGERABLE_PHASES.join(", ")}` });
      }

      const db = getDb();
      const [client] = await db
        .select({
          id: schema.clients.id,
          domain: schema.clients.domain,
          config: schema.clients.config,
        })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      if (!client) return reply.code(404).send({ error: "Client not found" });

      const { getScheduler } = await import("../core/scheduler.js");
      await getScheduler().addJob(phase, {
        clientId: client.id,
        clientDomain: client.domain,
        clientConfig: client.config,
        triggeredBy: "operator",
      });

      logger.info({ clientId, phase }, "Intelligence phase manually triggered");
      return { success: true, phase, clientId: client.id };
    },
  );

  /**
   * Anonymized cross-client rollup.
   *
   * The only non-client-scoped query in the intelligence surface. It returns
   * aggregates computed in SQL - the row-level data never reaches this process,
   * so there is nothing to accidentally serialize. Suppressed below
   * PORTFOLIO_MIN_CLIENTS distinct tenants.
   */
  app.get("/api/intelligence/portfolio", async () => {
    const db = getDb();

    const rows = await db
      .select({
        signalType: schema.intelligenceSignals.signalType,
        clientCount: sql<number>`count(distinct ${schema.intelligenceSignals.clientId})::int`,
        signalCount: sql<number>`count(*)::int`,
        avgConfidence: sql<number>`round(avg(${schema.intelligenceSignals.confidence})::numeric, 4)::float8`,
      })
      .from(schema.intelligenceSignals)
      .where(eq(schema.intelligenceSignals.status, "open"))
      .groupBy(schema.intelligenceSignals.signalType);

    const distinctClients = rows.reduce((max, row) => Math.max(max, row.clientCount), 0);

    if (distinctClients < PORTFOLIO_MIN_CLIENTS) {
      logger.info(
        { distinctClients, threshold: PORTFOLIO_MIN_CLIENTS },
        "Portfolio benchmark suppressed - too few clients to anonymize",
      );
      return {
        anonymized: true,
        suppressed: true,
        reason: `Fewer than ${PORTFOLIO_MIN_CLIENTS} clients with open signals - benchmark withheld to avoid re-identification`,
        benchmarks: [],
      };
    }

    return { anonymized: true, suppressed: false, benchmarks: rows };
  });

  logger.info("Intelligence routes registered");
}
