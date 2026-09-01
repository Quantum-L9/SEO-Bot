/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * L9 SEO Bot - Intelligence Service
 *
 * The closed-loop controller. Owns every database access in the module; the
 * extractor, scorer, gate, router and attributor are pure or query-only and are
 * composed here.
 *
 * THE LOOP DECIDES WHAT, THE SCHEDULER DECIDES WHEN, EXISTING MODULES DECIDE HOW.
 * This service never mutates SEO state: it does not write gap_analyses, does not
 * send mail, does not touch GitHub. Its only outward effects are
 * `scheduler.addJob` and rows in the intelligence/action tables. That keeps
 * every existing guarantee — token budgets, per-client fan-out, job_executions
 * logging, the circuit breaker — applying to intelligence-originated work
 * exactly as to cron-originated work. A private executor here would silently
 * opt out of all of them.
 */

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getConfig } from "../../core/config.js";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { getLlmService } from "../../services/llm.js";
import { type RouteResult, routeOpportunity } from "./action-router.js";
import { currentCapabilities, type IntelligenceCapabilities } from "./capabilities.js";
import { buildEvidencePack } from "./evidence-pack.js";
import {
  type OpportunityType,
  type ScoredOpportunity,
  scoreOpportunitiesFromSignals,
} from "./opportunity-scorer.js";
import {
  type AttributionResult,
  attributeRankingChange,
  BASELINE_DAYS,
  readyPhase,
  summarizeAttribution,
  windowFor,
} from "./outcome-attributor.js";
import { planActions, plannerActionVocabulary } from "./planner.js";
import { evaluateIntelligenceAction, requireClientId } from "./policy-gate.js";
import type { SignalType } from "./queries/index.js";
import { inferTargetUrlQuery } from "./queries/index.js";
import { type ExtractedSignal, extractSignals, type SignalSeverity } from "./signal-extractor.js";

const logger = createModuleLogger("intelligence:service");

/** Actions the planner may never take, stated to the model explicitly. */
const FORBIDDEN_ACTIONS = [
  "deploy_live_site_without_approval",
  "send_outreach_without_velocity_check",
  "execute_arbitrary_sql",
] as const;

export class IntelligenceService {
  private readonly capabilities: IntelligenceCapabilities;

  constructor(capabilities: IntelligenceCapabilities = currentCapabilities()) {
    this.capabilities = capabilities;
  }

  // ─── Run bookkeeping ──────────────────────────────────────────────────────

  /**
   * Wrap a phase so EVERY outcome lands in intelligence_runs — success, skip
   * and failure alike. A phase that throws must still close its row, otherwise
   * a crashed run is indistinguishable from one still in flight.
   */
  private async withRun<T>(
    clientId: string | null,
    runType: string,
    fn: (
      runId: string,
    ) => Promise<{ result: T; stats: Record<string, unknown>; llmUsed?: boolean }>,
  ): Promise<T> {
    const db = getDb();
    const startedAt = Date.now();
    const [row] = await db
      .insert(schema.intelligenceRuns)
      .values({ clientId, runType, status: "running", triggerSource: "scheduler" })
      .returning({ id: schema.intelligenceRuns.id });

    try {
      const { result, stats, llmUsed } = await fn(row.id);
      await db
        .update(schema.intelligenceRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          llmUsed: llmUsed === true,
          metadata: stats,
        })
        .where(eq(schema.intelligenceRuns.id, row.id));
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(schema.intelligenceRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
          error: message,
        })
        .where(eq(schema.intelligenceRuns.id, row.id));
      logger.error({ clientId, runType, err: message }, "Intelligence phase failed");
      throw error;
    }
  }

  // ─── Phase 1: extract signals ─────────────────────────────────────────────

  async extractSignals(clientId: string): Promise<void> {
    requireClientId(clientId);
    if (!this.capabilities.enabled) return;
    const config = getConfig();

    await this.withRun(clientId, "extract_signals", async (runId) => {
      const result = await extractSignals(clientId, runId, {
        dailyCap: config.DAILY_SPEND_CAP,
      });
      return { result: undefined, stats: { ...result.perFamily, total: result.total } };
    });
  }

  // ─── Phase 2: score opportunities ─────────────────────────────────────────

  async scoreOpportunities(clientId: string): Promise<void> {
    requireClientId(clientId);
    if (!this.capabilities.enabled) return;
    const db = getDb();

    await this.withRun(clientId, "score_opportunities", async (runId) => {
      const signals = await this.getOpenSignals(clientId);
      const opportunities = scoreOpportunitiesFromSignals(clientId, signals, {
        staleDays: this.capabilities.signalStaleDays,
      });

      // Fill in a target URL from observed data when the cluster did not carry
      // one. Client registration maps target keywords without a page URL, so
      // the planner cannot assume config supplies it.
      for (const opportunity of opportunities) {
        if (!opportunity.targetUrl) {
          opportunity.targetUrl = await this.inferTargetUrl(clientId, opportunity.targetKeyword);
        }
      }

      if (opportunities.length > 0) {
        await db
          .insert(schema.intelligenceOpportunities)
          .values(
            opportunities.map((o) => ({
              runId,
              clientId: o.clientId,
              opportunityType: o.opportunityType,
              title: o.title,
              description: o.description,
              targetUrl: o.targetUrl,
              targetKeyword: o.targetKeyword,
              fingerprint: o.fingerprint,
              expectedImpact: o.expectedImpact,
              confidence: o.confidence,
              urgency: o.urgency,
              effort: o.effort,
              risk: o.risk,
              score: o.score,
              evidence: o.evidence,
              signalFingerprints: o.signalFingerprints,
              rationale: o.rationale,
            })),
          )
          // `status` is excluded from the update set so a run cannot reopen an
          // opportunity an operator resolved or dismissed.
          .onConflictDoUpdate({
            target: [
              schema.intelligenceOpportunities.clientId,
              schema.intelligenceOpportunities.fingerprint,
            ],
            set: {
              runId: sql`excluded.run_id`,
              expectedImpact: sql`excluded.expected_impact`,
              confidence: sql`excluded.confidence`,
              urgency: sql`excluded.urgency`,
              score: sql`excluded.score`,
              targetUrl: sql`excluded.target_url`,
              targetKeyword: sql`excluded.target_keyword`,
              evidence: sql`excluded.evidence`,
              rationale: sql`excluded.rationale`,
              updatedAt: sql`now()`,
            },
          });
      }

      return {
        result: undefined,
        stats: {
          signals: signals.length,
          opportunities: opportunities.length,
          topScore: opportunities[0]?.score ?? 0,
        },
      };
    });
  }

  // ─── Phase 3: plan and route ──────────────────────────────────────────────

  async planActions(clientId: string): Promise<void> {
    requireClientId(clientId);
    if (!this.capabilities.enabled) return;
    const db = getDb();

    await this.withRun(clientId, "plan_actions", async (runId) => {
      const [client] = await db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .limit(1);

      const gateClient = client ? { id: client.id, active: client.active } : null;
      const opportunities = await this.getTopOpenOpportunities(
        clientId,
        this.capabilities.maxOpportunitiesPerClient,
      );

      if (opportunities.length === 0) {
        return { result: undefined, stats: { opportunities: 0, routed: 0 } };
      }

      // The planner is advisory: it narrows WHICH opportunities get routed, and
      // never widens what may be done to them. A planner failure therefore
      // degrades to "route nothing this run", which is the safe direction.
      let plannedTypes: Set<string> | null = null;
      let llmUsed = false;
      let plannerRejected = false;

      if (this.capabilities.usesLlmPlanner && client) {
        try {
          const pack = buildEvidencePack({
            clientId,
            clientDomain: client.domain,
            industry: client.industry,
            market: [client.city, client.state].filter(Boolean).join(", "),
            allowedActions: plannerActionVocabulary(),
            forbiddenActions: FORBIDDEN_ACTIONS,
            opportunities,
            signalsByFingerprint: await this.getSignalsByFingerprint(clientId),
          });
          const llm = getLlmService();
          const plan = await planActions(pack, {
            strategizeJson: (args) =>
              llm.strategizeJson({
                clientId: args.clientId,
                module: "intelligence",
                purpose: args.purpose,
                systemPrompt: args.systemPrompt,
                userPrompt: args.userPrompt,
                validate: args.validate,
              }),
          });
          llmUsed = true;
          plannedTypes = new Set(plan.actions.map((a) => a.opportunityType));
        } catch (error) {
          plannerRejected = true;
          logger.warn(
            { clientId, err: error instanceof Error ? error.message : String(error) },
            "Planner unavailable or rejected - routing nothing this run",
          );
          return {
            result: undefined,
            stats: { opportunities: opportunities.length, routed: 0, plannerRejected },
            llmUsed,
          };
        }
      }

      // Imported lazily: core/scheduler imports this module's registrar, so a
      // top-level import here would close an import cycle.
      const { getScheduler } = await import("../../core/scheduler.js");
      const scheduler = getScheduler();
      const llmBudgetExhausted = await this.isLlmBudgetExhausted(clientId);

      let routed = 0;
      let blocked = 0;
      const allResults: RouteResult[] = [];

      for (const opportunity of opportunities) {
        if (plannedTypes && !plannedTypes.has(opportunity.opportunityType)) continue;

        const duplicateActionPending = await this.hasPendingAction(clientId, opportunity.id);

        const results = await routeOpportunity(opportunity, {
          scheduler,
          clientDomain: client?.domain ?? "",
          clientConfig: client?.config ?? {},
          recordLink: (link) => this.recordLink(link),
          recordDecision: (entry) => this.recordDecision(runId, entry),
          // The gate derives outreach/mutation classification from the action
          // name itself, so the router's hint is not forwarded — one source of
          // truth for what an action is, not two that can disagree.
          evaluate: (action) =>
            evaluateIntelligenceAction({
              clientId,
              action,
              capabilities: this.capabilities,
              client: gateClient,
              score: opportunity.score,
              requiresLlm: false,
              llmBudgetExhausted,
              duplicateActionPending,
              // ROUTE_MAP never routes `intelligence_execute_site_change`, so no
              // live-mutation path reaches this gate today. Passed explicitly at
              // their safe values rather than omitted, so adding such a route
              // later fails closed here instead of inheriting `undefined` and
              // reading as "not blocked".
              siteDeploymentReady: false,
              siteDeployDryRun: true,
              outreachVelocityExhausted: false,
              rankingCircuitBreakerOpen: false,
            }),
        });

        allResults.push(...results);
        routed += results.filter((r) => r.outcome === "queued").length;
        blocked += results.filter((r) => r.outcome === "blocked").length;
      }

      return {
        result: undefined,
        stats: {
          opportunities: opportunities.length,
          considered: allResults.length,
          routed,
          blocked,
          plannerRejected,
        },
        llmUsed,
      };
    });
  }

  // ─── Phase 4: measure outcomes ────────────────────────────────────────────

  /**
   * Measure actions whose window has closed.
   *
   * Only keyword-targeted opportunities are attributable today: SERP position
   * is the one metric with a dependable before/after series per entity.
   * Attempting to attribute, say, a citation recovery on the same schedule
   * would produce confident-looking numbers from a much noisier signal.
   */
  async measureOutcomes(clientId: string): Promise<AttributionResult[]> {
    requireClientId(clientId);
    if (!this.capabilities.enabled) return [];
    const db = getDb();

    return this.withRun(clientId, "measure_outcomes", async () => {
      const links = await db
        .select({
          linkId: schema.intelligenceActionLinks.id,
          opportunityId: schema.intelligenceActionLinks.opportunityId,
          action: schema.intelligenceActionLinks.action,
          createdAt: schema.intelligenceActionLinks.createdAt,
          targetKeyword: schema.intelligenceOpportunities.targetKeyword,
          targetUrl: schema.intelligenceOpportunities.targetUrl,
          opportunityType: schema.intelligenceOpportunities.opportunityType,
        })
        .from(schema.intelligenceActionLinks)
        .innerJoin(
          schema.intelligenceOpportunities,
          eq(schema.intelligenceActionLinks.opportunityId, schema.intelligenceOpportunities.id),
        )
        .where(
          and(
            eq(schema.intelligenceActionLinks.clientId, clientId),
            eq(schema.intelligenceActionLinks.status, "queued"),
          ),
        )
        .limit(200);

      const results: AttributionResult[] = [];
      const now = new Date();

      for (const link of links) {
        const keyword = link.targetKeyword;
        if (!keyword) continue;

        const phase = readyPhase(link.createdAt, now);
        if (!phase) continue;

        const window = windowFor(link.createdAt, phase);
        const [before, after] = await Promise.all([
          this.avgPosition(clientId, keyword, window.baselineStart, window.baselineEnd),
          this.avgPosition(clientId, keyword, window.measurementStart, window.measurementEnd),
        ]);

        const result = attributeRankingChange({
          keyword,
          positionBefore: before,
          positionAfter: after,
          phase,
        });
        results.push(result);

        const [outcome] = await db
          .insert(schema.actionOutcomes)
          .values({
            clientId,
            module: "intelligence",
            action: link.action,
            executedAt: link.createdAt,
            measuredAt: now,
            positionBefore:
              result.positionBefore === null ? null : Math.round(result.positionBefore),
            positionAfter: result.positionAfter === null ? null : Math.round(result.positionAfter),
            success: result.success,
            learnings: result.learnings,
          })
          .returning({ id: schema.actionOutcomes.id });

        await db.insert(schema.intelligenceExperiments).values({
          clientId,
          opportunityId: link.opportunityId,
          actionOutcomeId: outcome.id,
          hypothesis: `${link.action} on "${keyword}" improves SERP position`,
          targetMetric: "serp_position",
          entityType: "keyword",
          entityKey: keyword,
          baselineStart: window.baselineStart,
          baselineEnd: window.baselineEnd,
          measurementStart: window.measurementStart,
          measurementEnd: window.measurementEnd,
          status: phase === "final" ? "complete" : "measuring",
          result: { ...result },
        });

        // Only a final verdict closes the loop. Earlier phases record evidence
        // without deciding, so a slow-moving win is not written off at day 7.
        if (phase === "final") {
          await db
            .update(schema.intelligenceActionLinks)
            .set({ status: "measured", actionOutcomeId: outcome.id })
            .where(eq(schema.intelligenceActionLinks.id, link.linkId));

          await db
            .update(schema.intelligenceOpportunities)
            .set({ status: result.success === true ? "won" : "lost", updatedAt: now })
            .where(eq(schema.intelligenceOpportunities.id, link.opportunityId));
        }
      }

      return { result: results, stats: summarizeAttribution(results) };
    });
  }

  // ─── Phase 5: portfolio benchmark ─────────────────────────────────────────

  /**
   * Anonymized cross-client rollup — the ONE non-client-scoped query in the
   * module. Aggregates are computed in SQL, so no row-level cross-tenant data
   * ever reaches this process and there is nothing to accidentally serialize.
   */
  async portfolioBenchmark(): Promise<Array<Record<string, unknown>>> {
    if (!this.capabilities.portfolioBenchmark) return [];
    const db = getDb();

    return this.withRun(null, "portfolio_benchmark", async () => {
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

      return { result: rows as Array<Record<string, unknown>>, stats: { families: rows.length } };
    });
  }

  // ─── Repository helpers ───────────────────────────────────────────────────

  private async getOpenSignals(clientId: string): Promise<ExtractedSignal[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.intelligenceSignals)
      .where(
        and(
          eq(schema.intelligenceSignals.clientId, clientId),
          eq(schema.intelligenceSignals.status, "open"),
          // A suppressed signal stays suppressed until its timer expires.
          or(
            isNull(schema.intelligenceSignals.suppressedUntil),
            sql`${schema.intelligenceSignals.suppressedUntil} < now()`,
          ),
        ),
      )
      .limit(1000);

    return rows.map((row) => ({
      clientId: row.clientId,
      signalType: row.signalType as SignalType,
      entityType: row.entityType,
      entityKey: row.entityKey,
      fingerprint: row.fingerprint,
      severity: row.severity as SignalSeverity,
      confidence: row.confidence ?? 0,
      evidence: (row.evidence ?? {}) as Record<string, unknown>,
      status: row.status,
      observedAt: row.observedAt,
    }));
  }

  private async getSignalsByFingerprint(clientId: string): Promise<Map<string, ExtractedSignal>> {
    const signals = await this.getOpenSignals(clientId);
    return new Map(signals.map((s) => [s.fingerprint, s]));
  }

  private async getTopOpenOpportunities(
    clientId: string,
    limit: number,
  ): Promise<Array<ScoredOpportunity & { id: string }>> {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(
        and(
          eq(schema.intelligenceOpportunities.clientId, clientId),
          eq(schema.intelligenceOpportunities.status, "open"),
        ),
      )
      .orderBy(desc(schema.intelligenceOpportunities.score))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      opportunityType: row.opportunityType as OpportunityType,
      fingerprint: row.fingerprint,
      title: row.title,
      description: row.description,
      targetUrl: row.targetUrl,
      targetKeyword: row.targetKeyword,
      expectedImpact: row.expectedImpact,
      confidence: row.confidence,
      urgency: row.urgency,
      effort: row.effort,
      risk: row.risk,
      score: row.score,
      signalFingerprints: (row.signalFingerprints ?? []) as string[],
      evidence: (row.evidence ?? {}) as Record<string, unknown>,
      rationale: row.rationale ?? "",
    }));
  }

  private async inferTargetUrl(clientId: string, keyword: string | null): Promise<string | null> {
    const db = getDb();
    const result = (await db.execute(inferTargetUrlQuery(clientId, keyword))) as unknown as {
      rows?: Array<{ url?: string | null }>;
    };
    return result?.rows?.[0]?.url ?? null;
  }

  private async avgPosition(
    clientId: string,
    keyword: string,
    from: Date,
    to: Date,
  ): Promise<number | null> {
    const db = getDb();
    const [row] = await db
      .select({ avg: sql<number | null>`avg(${schema.serpRankings.position})::float8` })
      .from(schema.serpRankings)
      .where(
        and(
          eq(schema.serpRankings.clientId, clientId),
          eq(schema.serpRankings.keyword, keyword),
          sql`${schema.serpRankings.checkedAt} >= ${from}`,
          sql`${schema.serpRankings.checkedAt} < ${to}`,
        ),
      );
    return row?.avg ?? null;
  }

  private async hasPendingAction(clientId: string, opportunityId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ id: schema.intelligenceActionLinks.id })
      .from(schema.intelligenceActionLinks)
      .where(
        and(
          eq(schema.intelligenceActionLinks.clientId, clientId),
          eq(schema.intelligenceActionLinks.opportunityId, opportunityId),
          eq(schema.intelligenceActionLinks.status, "pending_approval"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async recordDecision(
    runId: string,
    entry: {
      clientId: string;
      opportunityId: string;
      decisionType: string;
      decision: string;
      rationale: string;
      policyBasis: Record<string, unknown>;
      evidenceSummary: Record<string, unknown>;
      requiresApproval: boolean;
      actionLogId: string | null;
    },
  ): Promise<string | null> {
    const db = getDb();
    const [row] = await db
      .insert(schema.intelligenceDecisions)
      .values({ runId, ...entry })
      .returning({ id: schema.intelligenceDecisions.id });
    return row?.id ?? null;
  }

  /** Returns false when the UNIQUE constraint rejected the link (already routed). */
  private async recordLink(link: {
    clientId: string;
    opportunityId: string;
    decisionId: string | null;
    jobName: string | null;
    jobId: string | null;
    actionLogId: string | null;
    action: string;
    status: string;
    blockedReason: string | null;
  }): Promise<boolean> {
    const db = getDb();
    const inserted = await db
      .insert(schema.intelligenceActionLinks)
      .values(link)
      .onConflictDoNothing({
        target: [
          schema.intelligenceActionLinks.clientId,
          schema.intelligenceActionLinks.opportunityId,
          schema.intelligenceActionLinks.jobName,
        ],
      })
      .returning({ id: schema.intelligenceActionLinks.id });
    return inserted.length > 0;
  }

  /** Real spend from llm_usage — what LlmService writes, not the API estimate. */
  private async isLlmBudgetExhausted(clientId: string): Promise<boolean> {
    const cap = getConfig().DAILY_SPEND_CAP;
    if (typeof cap !== "number" || cap <= 0) return false;
    const db = getDb();
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${schema.llmUsage.cost}), 0)::float8` })
      .from(schema.llmUsage)
      .where(
        and(
          eq(schema.llmUsage.clientId, clientId),
          sql`${schema.llmUsage.timestamp} >= date_trunc('day', now())`,
        ),
      );
    return (row?.total ?? 0) >= cap;
  }
}

export { BASELINE_DAYS };
