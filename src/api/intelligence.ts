/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence read API (operator surface)
 *
 * Projections over the loop's tables for the operator dashboard. Read-only:
 * there is no route here that changes what the loop will do — mode and flags
 * are deployment configuration, deliberately not togglable over HTTP, so a
 * compromised operator session cannot widen autonomy.
 *
 * Every route is scoped to one client by path parameter, and every response
 * passes through an explicit projection rather than returning rows. Returning
 * a row would eventually leak a column somebody adds later; naming the fields
 * means a new column is invisible here until someone decides otherwise. That
 * matters most for `clients`, which holds `posthogApiKey` and a free-form
 * `config` blob that carries deployment credentials.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";

interface ClientParams {
  clientId: string;
}

/** Confirm the client exists before running any projection over its data. */
async function findClient(clientId: string): Promise<{ id: string; domain: string } | null> {
  const db = getDb();
  const [client] = await db
    .select({ id: schema.clients.id, domain: schema.clients.domain })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);
  return client ?? null;
}

export function registerIntelligenceRoutes(app: FastifyInstance): void {
  /**
   * Current signals and the loop's configuration as this process sees it.
   *
   * The flags are reported so an operator can confirm what a deployment is
   * actually permitted to do without shell access — the single most common
   * question during a staged rollout.
   */
  app.get<{ Params: ClientParams }>(
    "/api/clients/:clientId/intelligence",
    async (request, reply) => {
      const { clientId } = request.params;
      const client = await findClient(clientId);
      if (!client) return reply.code(404).send({ error: "Client not found" });

      const config = getConfig();
      const db = getDb();

      const signals = await db
        .select({
          signalType: schema.intelligenceSignals.signalType,
          severity: schema.intelligenceSignals.severity,
          subject: schema.intelligenceSignals.subject,
          evidence: schema.intelligenceSignals.evidence,
          status: schema.intelligenceSignals.status,
          firstObservedAt: schema.intelligenceSignals.firstObservedAt,
          observedAt: schema.intelligenceSignals.observedAt,
        })
        .from(schema.intelligenceSignals)
        .where(eq(schema.intelligenceSignals.clientId, clientId))
        .orderBy(desc(schema.intelligenceSignals.observedAt))
        .limit(200);

      const runs = await db
        .select({
          runType: schema.intelligenceRuns.runType,
          mode: schema.intelligenceRuns.mode,
          status: schema.intelligenceRuns.status,
          error: schema.intelligenceRuns.error,
          startedAt: schema.intelligenceRuns.startedAt,
          completedAt: schema.intelligenceRuns.completedAt,
        })
        .from(schema.intelligenceRuns)
        .where(eq(schema.intelligenceRuns.clientId, clientId))
        .orderBy(desc(schema.intelligenceRuns.startedAt))
        .limit(20);

      return {
        clientId,
        domain: client.domain,
        mode: config.INTELLIGENCE_MODE,
        capabilities: {
          llmPlanning: config.INTELLIGENCE_LLM_PLANNING_ENABLED === true,
          safeJobRouting: config.INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING === true,
          outreachRouting: config.INTELLIGENCE_ALLOW_OUTREACH_ROUTING === true,
          siteMutation: config.INTELLIGENCE_ALLOW_SITE_MUTATION === true,
        },
        signals,
        runs,
      };
    },
  );

  /** Scored opportunities, highest first, with their routing state. */
  app.get<{ Params: ClientParams }>(
    "/api/clients/:clientId/opportunities",
    async (request, reply) => {
      const { clientId } = request.params;
      const client = await findClient(clientId);
      if (!client) return reply.code(404).send({ error: "Client not found" });

      const db = getDb();
      const opportunities = await db
        .select({
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
        .limit(100);

      const decisions = await db
        .select({
          mode: schema.intelligenceDecisions.mode,
          source: schema.intelligenceDecisions.source,
          proposedAction: schema.intelligenceDecisions.proposedAction,
          decision: schema.intelligenceDecisions.decision,
          blockedReason: schema.intelligenceDecisions.blockedReason,
          createdAt: schema.intelligenceDecisions.createdAt,
        })
        .from(schema.intelligenceDecisions)
        .where(eq(schema.intelligenceDecisions.clientId, clientId))
        .orderBy(desc(schema.intelligenceDecisions.createdAt))
        .limit(100);

      return { clientId, domain: client.domain, opportunities, decisions };
    },
  );

  /**
   * Portfolio view across every client.
   *
   * Cross-tenant reads are forbidden by default (SECURITY.md), so this route
   * returns ONLY anonymized aggregates — counts by type and status, with no
   * client id, domain, keyword, or page path anywhere in the response. Even
   * so it is gated on the anonymized-benchmark flag, because "aggregate" is a
   * property of today's projection and a future edit could weaken it silently.
   */
  app.get("/api/intelligence/portfolio", async (_request, reply) => {
    const config = getConfig();
    if (config.INTELLIGENCE_PORTFOLIO_BENCHMARK !== true) {
      return reply.code(403).send({
        error:
          "Cross-client portfolio view is disabled. Set INTELLIGENCE_PORTFOLIO_BENCHMARK=true to enable anonymized benchmarking.",
      });
    }

    const db = getDb();
    const rows = await db
      .select({
        opportunityType: schema.intelligenceOpportunities.opportunityType,
        status: schema.intelligenceOpportunities.status,
        score: schema.intelligenceOpportunities.score,
      })
      .from(schema.intelligenceOpportunities);

    const buckets = new Map<string, { count: number; totalScore: number }>();
    for (const row of rows) {
      const key = `${row.opportunityType}::${row.status}`;
      const bucket = buckets.get(key) ?? { count: 0, totalScore: 0 };
      bucket.count += 1;
      bucket.totalScore += row.score;
      buckets.set(key, bucket);
    }

    return {
      anonymized: true,
      buckets: [...buckets.entries()].map(([key, bucket]) => {
        const [opportunityType, status] = key.split("::");
        return {
          opportunityType,
          status,
          count: bucket.count,
          averageScore: Math.round((bucket.totalScore / bucket.count) * 100) / 100,
        };
      }),
    };
  });
}
