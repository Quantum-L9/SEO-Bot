/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: policy gate
 *
 * Every capability the loop can reach passes through here first. The gate is
 * the ONLY place that decides what the current deployment is allowed to do; no
 * other module in `intelligence/` may consult INTELLIGENCE_MODE directly.
 *
 * Two independent conditions must both hold for any capability:
 *
 *   1. the MODE is at least the capability's minimum rung on the ladder, and
 *   2. the capability's own feature flag is on.
 *
 * They are independent on purpose. Turning a flag on cannot widen what the loop
 * may do (the mode still has to permit it), and raising the mode cannot switch
 * a capability on by itself (the flag still has to be set). Getting to a live
 * outreach email therefore requires two deliberate, separately-recorded
 * operator decisions.
 *
 * Beyond mode and flags the gate re-applies the runtime governors the executing
 * modules already enforce — the ranking circuit breaker, the link velocity cap,
 * the LLM daily spend cap, and site-deployment readiness — so the loop cannot
 * route work that the destination module would refuse.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getConfig } from "../../core/config.js";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { siteConfigFromClient } from "../../services/site-deployment.js";
import { SAFETY } from "../link-building/index.js";
import { velocityRunLimit } from "../link-building/velocity.js";
import { type GateVerdict, type IntelligenceMode, modeRank } from "./types.js";

const logger = createModuleLogger("intelligence:policy-gate");

/** Everything the loop can ask permission for. */
export type Capability =
  | "write_signals"
  | "write_decisions"
  | "route_safe_job"
  | "llm_planning"
  | "route_outreach"
  | "route_site_mutation";

/**
 * The lowest mode at which each capability becomes reachable, and the flag that
 * must additionally be set. `write_signals` and `write_decisions` have no flag:
 * the mode alone is the operator's decision for them, since neither leaves the
 * database.
 */
const CAPABILITY_REQUIREMENTS: Record<
  Capability,
  { minMode: IntelligenceMode; flag?: keyof ReturnType<typeof getConfig> }
> = {
  write_signals: { minMode: "observe" },
  write_decisions: { minMode: "recommend" },
  route_safe_job: { minMode: "route_safe", flag: "INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING" },
  llm_planning: { minMode: "route_llm", flag: "INTELLIGENCE_LLM_PLANNING_ENABLED" },
  route_outreach: { minMode: "full", flag: "INTELLIGENCE_ALLOW_OUTREACH_ROUTING" },
  route_site_mutation: { minMode: "full", flag: "INTELLIGENCE_ALLOW_SITE_MUTATION" },
};

const ALLOWED: GateVerdict = { allowed: true };

function blocked(gate: string, reason: string): GateVerdict {
  return { allowed: false, gate, reason };
}

/** The mode this process is running under. */
export function currentMode(): IntelligenceMode {
  return getConfig().INTELLIGENCE_MODE;
}

/**
 * Guard every entry point. A blank or missing client id is not a "no results"
 * condition — it is a caller bug that, left alone, would produce an unscoped
 * query and therefore a cross-tenant read. It throws rather than returning a
 * verdict so it cannot be swallowed by a caller that only checks `allowed`.
 */
export function assertClientId(clientId: string | undefined | null): asserts clientId is string {
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error("intelligence: clientId is required — refusing to run an unscoped query");
  }
}

/**
 * Mode + flag check. This is synchronous and pure with respect to the database,
 * so it is the cheapest gate and always runs first.
 */
export function checkCapability(capability: Capability): GateVerdict {
  const config = getConfig();
  const mode = config.INTELLIGENCE_MODE;

  if (mode === "off") {
    return blocked("mode", "INTELLIGENCE_MODE=off — the intelligence loop is disabled");
  }

  const requirement = CAPABILITY_REQUIREMENTS[capability];
  if (modeRank(mode) < modeRank(requirement.minMode)) {
    return blocked(
      "mode",
      `${capability} requires INTELLIGENCE_MODE >= ${requirement.minMode} (current: ${mode})`,
    );
  }

  if (requirement.flag && config[requirement.flag] !== true) {
    return blocked("flag", `${capability} requires ${requirement.flag}=true`);
  }

  return ALLOWED;
}

/**
 * A client that is inactive gets no autonomous work at all — including
 * observation. Deactivating a client is an operator saying "stop", and a loop
 * that kept extracting signals for them would be ignoring it.
 */
export async function checkClientActive(clientId: string): Promise<GateVerdict> {
  assertClientId(clientId);
  const db = getDb();
  const [client] = await db
    .select({ active: schema.clients.active })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  if (!client) return blocked("client", `client ${clientId} not found`);
  if (!client.active) return blocked("client", `client ${clientId} is inactive`);
  return ALLOWED;
}

/**
 * The LLM daily spend cap, checked BEFORE planning rather than after.
 *
 * Checking after the call would let a planner that fails validation retry
 * against a cap it has already blown. Deferring here means an exhausted budget
 * ends the planning stage quietly instead of looping.
 */
export async function checkLlmBudget(): Promise<GateVerdict> {
  const cap = getConfig().DAILY_SPEND_CAP;
  if (!cap || cap <= 0) return ALLOWED;

  const db = getDb();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ totalCost: sql<number>`COALESCE(SUM(${schema.llmUsage.cost}), 0)` })
    .from(schema.llmUsage)
    .where(gte(schema.llmUsage.timestamp, todayStart));

  const spent = Number(rows[0]?.totalCost ?? 0);
  if (spent >= cap) {
    return blocked(
      "llm_budget",
      `daily LLM spend cap reached ($${spent.toFixed(2)} >= $${cap.toFixed(2)})`,
    );
  }
  return ALLOWED;
}

/**
 * The ranking circuit breaker, mirroring link-building's own check against the
 * same SAFETY constants.
 *
 * When a client's rankings are already falling, more autonomous outward action
 * is the wrong response: the loop stands down and leaves the situation to a
 * human rather than compounding it.
 */
export async function checkRankingCircuitBreaker(clientId: string): Promise<GateVerdict> {
  assertClientId(clientId);
  const db = getDb();

  const recent = await db
    .select({
      position: schema.serpRankings.position,
      previousPosition: schema.serpRankings.previousPosition,
    })
    .from(schema.serpRankings)
    .where(eq(schema.serpRankings.clientId, clientId))
    .orderBy(desc(schema.serpRankings.checkedAt))
    .limit(10);

  const significantDrops = recent.filter(
    (r) =>
      r.previousPosition !== null &&
      r.position !== null &&
      r.previousPosition > 0 &&
      ((r.position - r.previousPosition) / r.previousPosition) * 100 > SAFETY.circuitBreakerDropPct,
  );

  if (significantDrops.length > 2) {
    return blocked(
      "circuit_breaker",
      `rankings dropping (${significantDrops.length} significant drops) — autonomous action paused`,
    );
  }
  return ALLOWED;
}

/**
 * The weekly link velocity cap, computed with link-building's own governor so
 * the two can never disagree about how much headroom is left.
 */
export async function checkOutreachVelocity(clientId: string): Promise<GateVerdict> {
  assertClientId(clientId);
  const db = getDb();
  const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000);

  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.linkProspects)
    .where(
      and(
        eq(schema.linkProspects.clientId, clientId),
        eq(schema.linkProspects.status, "outreach_queued"),
        gte(schema.linkProspects.updatedAt, oneWeekAgo),
      ),
    );

  const sentThisWeek = Number(rows[0]?.count ?? 0);
  const runLimit = velocityRunLimit(sentThisWeek, SAFETY.maxLinksPerWeek, SAFETY.maxEmailsPerDay);
  if (runLimit === 0) {
    return blocked(
      "velocity",
      `weekly link velocity cap reached (${sentThisWeek}/${SAFETY.maxLinksPerWeek})`,
    );
  }
  return ALLOWED;
}

export interface SiteMutationReadiness {
  /** The client has a usable deployment target configured. */
  ready: boolean;
  /**
   * A write would actually reach GitHub/Vercel. False whenever NODE_ENV=test,
   * SITE_DEPLOY_DRY_RUN=true, or the config is incomplete.
   */
  live: boolean;
}

/**
 * Split site-deployment state into readiness and liveness, because the loop
 * treats them differently.
 *
 * NOT READY (no repo, no token, unverified contract) blocks routing outright —
 * there is nowhere to send the work.
 *
 * READY BUT NOT LIVE is the intended state of the full dry-run rehearsal: the
 * work routes, the transport logs what it would have written, and nothing
 * reaches GitHub. That is the whole point of that stage, so it must not block.
 */
export function siteMutationReadiness(
  clientConfig?: Record<string, unknown>,
): SiteMutationReadiness {
  const resolved = siteConfigFromClient(clientConfig as never);
  const ready = Boolean(resolved.githubToken) && Boolean(resolved.websiteBotRepo);
  return { ready, live: ready && !resolved.dryRun };
}

/**
 * The single call every routing decision makes.
 *
 * Ordered cheapest-first — mode and flags before any query — and fail-closed:
 * the first refusal wins and is returned verbatim, so the audit trail names the
 * exact gate rather than a generic denial.
 */
export async function evaluateGate(params: {
  capability: Capability;
  clientId: string;
  clientConfig?: Record<string, unknown>;
}): Promise<GateVerdict> {
  const { capability, clientId, clientConfig } = params;
  assertClientId(clientId);

  const capabilityVerdict = checkCapability(capability);
  if (!capabilityVerdict.allowed) return capabilityVerdict;

  const activeVerdict = await checkClientActive(clientId);
  if (!activeVerdict.allowed) return activeVerdict;

  if (capability === "llm_planning") {
    const budgetVerdict = await checkLlmBudget();
    if (!budgetVerdict.allowed) return budgetVerdict;
  }

  // Outward, irreversible action answers to the runtime governors too.
  if (capability === "route_outreach") {
    const breakerVerdict = await checkRankingCircuitBreaker(clientId);
    if (!breakerVerdict.allowed) return breakerVerdict;

    const velocityVerdict = await checkOutreachVelocity(clientId);
    if (!velocityVerdict.allowed) return velocityVerdict;
  }

  if (capability === "route_site_mutation") {
    const breakerVerdict = await checkRankingCircuitBreaker(clientId);
    if (!breakerVerdict.allowed) return breakerVerdict;

    const { ready } = siteMutationReadiness(clientConfig);
    if (!ready) {
      return blocked(
        "site_deployment",
        "client site_deployment is not ready (missing credential or target repo)",
      );
    }
  }

  logger.debug({ capability, clientId }, "policy gate allowed");
  return ALLOWED;
}
