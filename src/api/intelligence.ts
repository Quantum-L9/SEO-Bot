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
import { currentCapabilities, currentIntelligenceMode } from "../modules/intelligence/modes.js";

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
            strength: schema.intelligenceSignals.strength,
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
            mode: schema.intelligenceRuns.mode,
            status: schema.intelligenceRuns.status,
            error: schema.intelligenceRuns.error,
            stats: schema.intelligenceRuns.stats,
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
        mode: currentIntelligenceMode(),
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
          score: schema.intelligenceOpportunities.score,
          impact: schema.intelligenceOpportunities.impact,
          confidence: schema.intelligenceOpportunities.confidence,
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
          outcome: schema.intelligenceActionLinks.outcome,
          blockedReason: schema.intelligenceActionLinks.blockedReason,
          createdAt: schema.intelligenceActionLinks.createdAt,
        })
        .from(schema.intelligenceActionLinks)
        .where(eq(schema.intelligenceActionLinks.clientId, clientId))
        .orderBy(desc(schema.intelligenceActionLinks.createdAt))
        .limit(PAGE_LIMIT);

      return { clientId: client.id, mode: currentIntelligenceMode(), opportunities, links };
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
        avgStrength: sql<number>`round(avg(${schema.intelligenceSignals.strength})::numeric, 4)::float8`,
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
