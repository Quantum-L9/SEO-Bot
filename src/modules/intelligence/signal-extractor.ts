/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Intelligence Signal Extraction
 *
 * Turns operational rows into deterministic, fingerprinted observations.
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD:
 *
 * 1. TENANT ISOLATION. Every query filters on the clientId passed in. There is
 *    no cross-client read anywhere in this file — the portfolio surface is a
 *    separate, explicitly anonymized path. `assertClientId` throws rather than
 *    letting an undefined clientId reach a WHERE clause, because a missing
 *    filter in Drizzle is a silently portfolio-wide query, not an error.
 *
 * 2. NO LLM. Extraction is pure rules over rows. The same inputs always produce
 *    the same signals and the same severities, so the scorer downstream is
 *    reproducible and an operator can audit why a signal fired.
 *
 * 3. IDEMPOTENCY. BullMQ is at-least-once, so this runs twice on the same data
 *    routinely. Each signal carries a fingerprint of (clientId, type, entity)
 *    and is written with ON CONFLICT DO UPDATE. A second run refreshes
 *    `observed_at` and the evidence; it never creates a second row and never
 *    reopens a signal an operator suppressed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";

const logger = createModuleLogger("intelligence:signals");

// ─── Signal vocabulary ───────────────────────────────────────────────────────

export type SignalType = "keyword_drop" | "bad_lcp_high_exit" | "citation_loss" | "prospect_ready";

export type SignalSeverity = "low" | "medium" | "high" | "critical";

export interface ExtractedSignal {
  clientId: string;
  signalType: SignalType;
  fingerprint: string;
  entityKey: string;
  severity: SignalSeverity;
  /** 0..1 rules-derived strength consumed by the scorer. */
  strength: number;
  evidence: Record<string, unknown>;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────
// Named rather than inlined so a test can assert the boundary rather than a
// magic number, and so tuning is a one-line reviewed diff.

export const THRESHOLDS = {
  /** Positions lost before a ranking move counts as a drop. */
  keywordDropMinDelta: 3,
  /** LCP (seconds) at or above which Core Web Vitals is "poor". */
  lcpPoorSeconds: 4.0,
  /** Exit rate (0..1) at or above which a page is a dead end. */
  highExitRate: 0.7,
  /** Minimum domain rating for a link prospect to be worth outreach. */
  prospectMinDomainRating: 30,
} as const;

/**
 * Stable identity for a signal.
 *
 * Includes clientId so two tenants observing the same keyword never collide on
 * a shared fingerprint — the DB unique index is (client_id, fingerprint), but
 * hashing the client in as well means a fingerprint is globally meaningful and
 * a copy-paste bug cannot alias one tenant's signal onto another's row.
 */
export function signalFingerprint(
  clientId: string,
  signalType: SignalType,
  entityKey: string,
): string {
  return createHash("sha256").update(`${clientId}|${signalType}|${entityKey}`).digest("hex");
}

/**
 * Guard against an undefined/blank clientId reaching a query.
 *
 * Drizzle's `eq(col, undefined)` does not throw — it produces a comparison that
 * silently widens the result set. For a multi-tenant table that is a
 * cross-tenant read, so this is a hard failure rather than a warning.
 */
export function assertClientId(clientId: string | undefined | null): asserts clientId is string {
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error(
      "intelligence: clientId is required for every signal query (refusing to run an unscoped, cross-tenant read)",
    );
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ─── Extractors ──────────────────────────────────────────────────────────────

/**
 * keyword_drop — a tracked keyword lost ground.
 *
 * `position` is nullable in serp_rankings (a keyword can fall out of the top
 * 100 entirely), so every arithmetic path here checks for null first: a null
 * position is "unknown", not "position 0", and treating it as a number would
 * manufacture a 100-place improvement.
 */
export async function extractKeywordDropSignals(clientId: string): Promise<ExtractedSignal[]> {
  assertClientId(clientId);
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.serpRankings)
    .where(eq(schema.serpRankings.clientId, clientId))
    .orderBy(desc(schema.serpRankings.checkedAt))
    .limit(500);

  const seen = new Set<string>();
  const signals: ExtractedSignal[] = [];

  for (const row of rows) {
    // Most recent row per keyword wins; older rows are history.
    if (seen.has(row.keyword)) continue;
    seen.add(row.keyword);

    const current = row.position;
    const previous = row.previousPosition;
    if (current === null || previous === null) continue;

    const delta = current - previous; // positive = worse (higher number = lower rank)
    if (delta < THRESHOLDS.keywordDropMinDelta) continue;

    signals.push({
      clientId,
      signalType: "keyword_drop",
      fingerprint: signalFingerprint(clientId, "keyword_drop", row.keyword),
      entityKey: row.keyword,
      severity: severityForKeywordDrop(delta, current),
      strength: clamp01(delta / 20),
      evidence: {
        keyword: row.keyword,
        currentPosition: current,
        previousPosition: previous,
        delta,
        url: row.url,
        checkedAt: row.checkedAt,
      },
    });
  }

  return signals;
}

/**
 * A drop out of page one is worse than the same delta deep in the results:
 * losing #3 -> #11 costs nearly all the traffic, #40 -> #48 costs almost none.
 */
export function severityForKeywordDrop(delta: number, currentPosition: number): SignalSeverity {
  const previousPosition = currentPosition - delta;
  // "Left page one" must mean the move CROSSED the boundary, not merely that it
  // ended past it. A keyword already sitting at #40 that slid to #48 never had
  // page-one traffic to lose; scoring it on `currentPosition > 10` alone would
  // rank it the same as a #3 -> #11 collapse.
  const crossedOffPageOne = previousPosition <= 10 && currentPosition > 10;
  if (delta >= 10 && crossedOffPageOne) return "critical";
  if (crossedOffPageOne) return "high";
  if (delta >= 10) return "high";
  if (delta >= 5) return "medium";
  return "low";
}

/**
 * bad_lcp_high_exit — a slow page that visitors also abandon.
 *
 * The join is the point: a slow page nobody visits is not urgent, and a
 * high-exit page that loads fast is a content problem, not a performance one.
 * Only the intersection is actionable, so this correlates web_vitals.url with
 * page_engagement.pagePath rather than reporting either alone.
 *
 * The two tables key pages differently — web_vitals stores a full URL,
 * page_engagement stores a path — so the URL is normalized to a path before
 * comparison. Without that, the join silently matches nothing and the signal
 * type never fires.
 */
export async function extractBadLcpHighExitSignals(clientId: string): Promise<ExtractedSignal[]> {
  assertClientId(clientId);
  const db = getDb();

  const [vitals, engagement] = await Promise.all([
    db
      .select()
      .from(schema.webVitals)
      .where(eq(schema.webVitals.clientId, clientId))
      .orderBy(desc(schema.webVitals.measuredAt))
      .limit(500),
    db
      .select()
      .from(schema.pageEngagement)
      .where(eq(schema.pageEngagement.clientId, clientId))
      .orderBy(desc(schema.pageEngagement.computedAt))
      .limit(500),
  ]);

  const engagementByPath = new Map<string, (typeof engagement)[number]>();
  for (const row of engagement) {
    const path = normalizePagePath(row.pagePath);
    if (path && !engagementByPath.has(path)) engagementByPath.set(path, row);
  }

  const seen = new Set<string>();
  const signals: ExtractedSignal[] = [];

  for (const vital of vitals) {
    const path = normalizePagePath(vital.url);
    if (!path || seen.has(path)) continue;

    const lcp = vital.lcp;
    if (lcp === null || lcp < THRESHOLDS.lcpPoorSeconds) continue;

    const match = engagementByPath.get(path);
    if (!match) continue;

    const exitRate = match.exitRate;
    if (exitRate === null || exitRate < THRESHOLDS.highExitRate) continue;

    seen.add(path);
    signals.push({
      clientId,
      signalType: "bad_lcp_high_exit",
      fingerprint: signalFingerprint(clientId, "bad_lcp_high_exit", path),
      entityKey: path,
      severity: exitRate >= 0.85 || lcp >= 6 ? "high" : "medium",
      strength: clamp01((lcp - THRESHOLDS.lcpPoorSeconds) / 4) * 0.5 + clamp01(exitRate) * 0.5,
      evidence: {
        path,
        url: vital.url,
        lcp,
        exitRate,
        avgTimeOnPage: match.avgTimeOnPage,
        uniqueVisitors: match.uniqueVisitors,
        device: vital.device,
      },
    });
  }

  return signals;
}

/**
 * Reduce a stored URL or path to a comparable path.
 * Returns null for input that is not usable as a join key, so a malformed row
 * is skipped rather than matching everything under an empty-string key.
 */
export function normalizePagePath(input: string | null | undefined): string | null {
  if (!input) return null;
  let path = input.trim();
  if (path === "") return null;

  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }

  if (!path.startsWith("/")) path = `/${path}`;
  // Trailing slash is not a distinct page; "/pricing" and "/pricing/" must join.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * citation_loss — the client was cited for a query and no longer is.
 *
 * Platforms with no coverage at all are skipped rather than reported as a loss:
 * "we have never been cited on this platform" and "we were cited and lost it"
 * are different facts, and only the second is a signal. A platform whose only
 * rows are all `cited: false` has no prior citation to lose.
 */
export async function extractCitationLossSignals(clientId: string): Promise<ExtractedSignal[]> {
  assertClientId(clientId);
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.aeoCitations)
    .where(eq(schema.aeoCitations.clientId, clientId))
    .orderBy(desc(schema.aeoCitations.checkedAt))
    .limit(500);

  // Group by (platform, query): newest first thanks to the ORDER BY.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.platform || !row.query) continue;
    const key = `${row.platform}::${row.query}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const signals: ExtractedSignal[] = [];

  for (const [key, bucket] of groups) {
    const [latest, ...history] = bucket;
    if (!latest || latest.cited) continue;

    // Only a real loss counts: there must be an earlier citation to have lost.
    const everCited = history.some((row) => row.cited);
    if (!everCited) continue;

    signals.push({
      clientId,
      signalType: "citation_loss",
      fingerprint: signalFingerprint(clientId, "citation_loss", key),
      entityKey: key,
      severity: latest.competitorCited ? "high" : "medium",
      strength: latest.competitorCited ? 0.8 : 0.5,
      evidence: {
        platform: latest.platform,
        query: latest.query,
        competitorCited: latest.competitorCited,
        lastCitedAt: history.find((row) => row.cited)?.checkedAt ?? null,
        checkedAt: latest.checkedAt,
      },
    });
  }

  return signals;
}

/**
 * prospect_ready — a discovered link prospect worth contacting.
 *
 * Deliberately narrow: status must still be `discovered` (not already
 * contacted, which would make outreach a duplicate), a contact email must
 * exist, and domain rating must clear the floor. This signal is the only one
 * that can lead to an irreversible action, so its preconditions are the
 * strictest.
 */
export async function extractProspectReadySignals(clientId: string): Promise<ExtractedSignal[]> {
  assertClientId(clientId);
  const db = getDb();

  const rows = await db
    .select()
    .from(schema.linkProspects)
    .where(
      and(
        eq(schema.linkProspects.clientId, clientId),
        eq(schema.linkProspects.status, "discovered"),
      ),
    )
    .orderBy(desc(schema.linkProspects.createdAt))
    .limit(200);

  const signals: ExtractedSignal[] = [];

  for (const row of rows) {
    const dr = row.domainRating;
    if (dr === null || dr < THRESHOLDS.prospectMinDomainRating) continue;
    if (!row.contactEmail) continue;

    signals.push({
      clientId,
      signalType: "prospect_ready",
      fingerprint: signalFingerprint(clientId, "prospect_ready", row.targetUrl),
      entityKey: row.targetUrl,
      severity: dr >= 60 ? "high" : "medium",
      strength: clamp01(dr / 100),
      evidence: {
        targetUrl: row.targetUrl,
        domainRating: dr,
        relevanceScore: row.relevanceScore,
        tactic: row.tactic,
        status: row.status,
        // NOTE: contactEmail is deliberately NOT copied into evidence. Evidence
        // is what reaches the LLM planner and the operator API; a prospect's
        // email address is PII with no bearing on whether to act.
        hasContactEmail: true,
      },
    });
  }

  return signals;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export interface PersistSignalsResult {
  inserted: number;
  updated: number;
  total: number;
}

/**
 * Upsert signals on (client_id, fingerprint).
 *
 * `status` is intentionally absent from the update set: an operator who
 * suppressed a signal must not have it silently reopened by the next
 * extraction run. `first_seen_at` is likewise preserved — it records when the
 * problem started, which is exactly what a re-observation must not reset.
 */
export async function persistSignals(signals: ExtractedSignal[]): Promise<PersistSignalsResult> {
  if (signals.length === 0) return { inserted: 0, updated: 0, total: 0 };

  const db = getDb();
  const observedAt = new Date();

  const rows = signals.map((signal) => ({
    clientId: signal.clientId,
    signalType: signal.signalType,
    fingerprint: signal.fingerprint,
    entityKey: signal.entityKey,
    severity: signal.severity,
    strength: signal.strength,
    evidence: signal.evidence,
    observedAt,
  }));

  const returned = await db
    .insert(schema.intelligenceSignals)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.intelligenceSignals.clientId, schema.intelligenceSignals.fingerprint],
      set: {
        severity: sql`excluded.severity`,
        strength: sql`excluded.strength`,
        evidence: sql`excluded.evidence`,
        observedAt: sql`excluded.observed_at`,
      },
    })
    .returning({
      id: schema.intelligenceSignals.id,
      firstSeenAt: schema.intelligenceSignals.firstSeenAt,
    });

  // A row whose first_seen_at predates this run was an update, not an insert.
  let updated = 0;
  for (const row of returned) {
    if (row.firstSeenAt && row.firstSeenAt.getTime() < observedAt.getTime()) updated++;
  }

  return { inserted: returned.length - updated, updated, total: returned.length };
}

/**
 * Run every extractor for one client and persist the result.
 *
 * Extractors run concurrently because they read disjoint tables, but a failure
 * in one must not silently drop the others' findings — `Promise.all` rejects
 * the whole run so the intelligence_runs row records a real failure rather than
 * a partial success that looks complete.
 */
export async function extractSignals(clientId: string): Promise<{
  signals: ExtractedSignal[];
  persisted: PersistSignalsResult;
}> {
  assertClientId(clientId);

  const groups = await Promise.all([
    extractKeywordDropSignals(clientId),
    extractBadLcpHighExitSignals(clientId),
    extractCitationLossSignals(clientId),
    extractProspectReadySignals(clientId),
  ]);

  const signals = groups.flat();

  // Defence in depth: if any extractor ever returns a foreign row, fail loudly
  // here rather than writing it. The extractors already filter by clientId;
  // this catches a future edit that forgets to.
  const foreign = signals.filter((signal) => signal.clientId !== clientId);
  if (foreign.length > 0) {
    throw new Error(
      `intelligence: extraction produced ${foreign.length} signal(s) for a different client — refusing to persist`,
    );
  }

  const persisted = await persistSignals(signals);

  logger.info({ clientId, signals: signals.length, ...persisted }, "Signal extraction complete");

  return { signals, persisted };
}
