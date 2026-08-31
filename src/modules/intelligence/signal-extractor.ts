/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: signal extraction
 *
 * Reads the producer tables and derives the four deterministic signal types.
 * No LLM, no network, no mutation of anything outside `intelligence_signals`.
 *
 * TENANT ISOLATION — the invariant this file exists to hold:
 * every query below filters on `clientId`, and every fingerprint is salted with
 * it. There is no code path that reads another client's rows, and no code path
 * that writes a signal whose `client_id` differs from the one passed in. The
 * suite asserts both directions.
 *
 * IDEMPOTENCY: writes are upserts on (client_id, fingerprint). A retried job
 * refreshes `observed_at` and the evidence on the SAME row; it never opens a
 * second signal, and it never resets `first_observed_at` or clobbers a
 * `suppressed` status an operator set.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { SAFETY } from "../link-building/index.js";
import { THRESHOLDS } from "../web-vitals/index.js";
import { normalizeSubject, signalFingerprint } from "./fingerprint.js";
import { assertClientId } from "./policy-gate.js";
import type { Signal, SignalSeverity } from "./types.js";

const logger = createModuleLogger("intelligence:signals");

/** How far back the extractor looks. Older readings are history, not signal. */
const LOOKBACK_DAYS = 14;

/** A keyword must fall at least this many places to register at all. */
const MIN_POSITION_DROP = 3;

/** A page must lose at least this share of visitors to count as "high exit". */
const HIGH_EXIT_RATE = 0.6;

function lookbackFrom(now: Date): Date {
  return new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
}

/**
 * Severity for a ranking fall.
 *
 * Graded by where the keyword LANDED, not only by how far it moved: falling
 * out of the top ten costs nearly all the clicks, so 8 → 11 is worse news than
 * 40 → 55 even though the second moved further.
 */
export function keywordDropSeverity(previous: number, current: number): SignalSeverity {
  const fell = current - previous;
  if (previous <= 10 && current > 10) return "critical";
  if (fell >= 10) return "critical";
  if (fell >= 5) return "warning";
  return "info";
}

/**
 * Reduce a stored URL to a comparable page path.
 *
 * `web_vitals.url` holds absolute URLs and `page_engagement.page_path` holds
 * paths, so one side has to be normalized before the two can be joined at all.
 * A URL that will not parse degrades to its normalized string rather than
 * throwing — a malformed row should drop out of the join, not fail the run.
 */
export function urlToPath(url: string): string {
  try {
    return normalizeSubject(new URL(url).pathname) || "/";
  } catch {
    return normalizeSubject(url);
  }
}

/**
 * Keywords that fell materially in the window.
 *
 * Rows with a null position (not ranking / not measured) are excluded rather
 * than treated as position 0 — "we have no reading" is not "we rank first",
 * and coercing it either way manufactures a signal out of missing data.
 */
async function extractKeywordDrops(clientId: string, since: Date): Promise<Signal[]> {
  const db = getDb();
  const rows = await db
    .select({
      keyword: schema.serpRankings.keyword,
      position: schema.serpRankings.position,
      previousPosition: schema.serpRankings.previousPosition,
      checkedAt: schema.serpRankings.checkedAt,
    })
    .from(schema.serpRankings)
    .where(
      and(
        eq(schema.serpRankings.clientId, clientId),
        gte(schema.serpRankings.checkedAt, since),
        isNotNull(schema.serpRankings.position),
        isNotNull(schema.serpRankings.previousPosition),
      ),
    )
    .orderBy(desc(schema.serpRankings.checkedAt));

  // Latest reading per keyword wins — the ordering above puts it first.
  const latestByKeyword = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = normalizeSubject(row.keyword);
    if (!latestByKeyword.has(key)) latestByKeyword.set(key, row);
  }

  const signals: Signal[] = [];
  for (const row of latestByKeyword.values()) {
    const position = row.position;
    const previous = row.previousPosition;
    if (position === null || previous === null) continue;
    if (position - previous < MIN_POSITION_DROP) continue;

    signals.push({
      clientId,
      signalType: "keyword_drop",
      fingerprint: signalFingerprint(clientId, "keyword_drop", row.keyword),
      severity: keywordDropSeverity(previous, position),
      subject: row.keyword,
      evidence: {
        previousPosition: previous,
        currentPosition: position,
        positionsLost: position - previous,
      },
    });
  }
  return signals;
}

/**
 * Pages that are BOTH slow and losing visitors.
 *
 * The conjunction is the point. A slow page nobody leaves is not urgent, and a
 * page with a high exit rate that loads fast has a content problem, not a
 * performance one. Only where the two coincide is "fix the page experience" a
 * defensible reading of the evidence.
 */
async function extractBadLcpHighExit(clientId: string, since: Date): Promise<Signal[]> {
  const db = getDb();

  const vitals = await db
    .select({
      url: schema.webVitals.url,
      lcp: schema.webVitals.lcp,
      measuredAt: schema.webVitals.measuredAt,
    })
    .from(schema.webVitals)
    .where(
      and(
        eq(schema.webVitals.clientId, clientId),
        gte(schema.webVitals.measuredAt, since),
        isNotNull(schema.webVitals.lcp),
      ),
    )
    .orderBy(desc(schema.webVitals.measuredAt));

  const engagement = await db
    .select({
      pagePath: schema.pageEngagement.pagePath,
      exitRate: schema.pageEngagement.exitRate,
      totalPageviews: schema.pageEngagement.totalPageviews,
      computedAt: schema.pageEngagement.computedAt,
    })
    .from(schema.pageEngagement)
    .where(
      and(
        eq(schema.pageEngagement.clientId, clientId),
        gte(schema.pageEngagement.computedAt, since),
        isNotNull(schema.pageEngagement.exitRate),
      ),
    )
    .orderBy(desc(schema.pageEngagement.computedAt));

  const worstLcpByPath = new Map<string, number>();
  for (const row of vitals) {
    if (row.lcp === null) continue;
    const path = urlToPath(row.url);
    const existing = worstLcpByPath.get(path);
    if (existing === undefined || row.lcp > existing) worstLcpByPath.set(path, row.lcp);
  }

  const exitByPath = new Map<string, { exitRate: number; pageviews: number }>();
  for (const row of engagement) {
    if (row.exitRate === null) continue;
    const path = normalizeSubject(row.pagePath);
    // First occurrence is the most recent — later ones are older periods.
    if (!exitByPath.has(path)) {
      exitByPath.set(path, { exitRate: row.exitRate, pageviews: row.totalPageviews ?? 0 });
    }
  }

  const signals: Signal[] = [];
  for (const [path, lcp] of worstLcpByPath) {
    const engagementRow = exitByPath.get(path);
    // No engagement reading for this page → no join. Half the evidence is not
    // a weaker signal, it is a different (absent) one.
    if (!engagementRow) continue;
    if (lcp <= THRESHOLDS.lcp.poor) continue;
    if (engagementRow.exitRate < HIGH_EXIT_RATE) continue;

    signals.push({
      clientId,
      signalType: "bad_lcp_high_exit",
      fingerprint: signalFingerprint(clientId, "bad_lcp_high_exit", path),
      severity: engagementRow.pageviews >= 100 ? "critical" : "warning",
      subject: path,
      evidence: {
        lcpMs: Math.round(lcp),
        lcpPoorThresholdMs: THRESHOLDS.lcp.poor,
        exitRate: Number(engagementRow.exitRate.toFixed(3)),
        pageviews: engagementRow.pageviews,
      },
    });
  }
  return signals;
}

/**
 * Answer-engine citations that were held and then lost.
 *
 * A platform is only considered when it has BOTH a prior cited reading and a
 * later uncited one for the same query. A platform that has never returned a
 * citation is a platform with no data — a placeholder, an integration that was
 * never enabled — and reading "we lost it" out of that would be inventing a
 * regression that never happened.
 */
async function extractCitationLoss(clientId: string, since: Date): Promise<Signal[]> {
  const db = getDb();
  const rows = await db
    .select({
      query: schema.aeoCitations.query,
      platform: schema.aeoCitations.platform,
      cited: schema.aeoCitations.cited,
      checkedAt: schema.aeoCitations.checkedAt,
    })
    .from(schema.aeoCitations)
    .where(
      and(eq(schema.aeoCitations.clientId, clientId), gte(schema.aeoCitations.checkedAt, since)),
    )
    .orderBy(desc(schema.aeoCitations.checkedAt));

  const byPair = new Map<
    string,
    { latest?: boolean; everCited: boolean; platform: string; query: string }
  >();
  for (const row of rows) {
    const key = `${row.platform}::${normalizeSubject(row.query)}`;
    const entry = byPair.get(key) ?? {
      everCited: false,
      platform: row.platform,
      query: row.query,
    };
    // Rows arrive newest-first, so the first one seen is the latest.
    if (entry.latest === undefined) entry.latest = row.cited;
    if (row.cited) entry.everCited = true;
    byPair.set(key, entry);
  }

  const signals: Signal[] = [];
  for (const entry of byPair.values()) {
    // Never cited → no data, not a loss.
    if (!entry.everCited) continue;
    // Still cited → nothing lost.
    if (entry.latest !== false) continue;

    const subject = `${entry.platform}:${normalizeSubject(entry.query)}`;
    signals.push({
      clientId,
      signalType: "citation_loss",
      fingerprint: signalFingerprint(clientId, "citation_loss", subject),
      severity: "warning",
      subject,
      evidence: { platform: entry.platform, previouslyCited: 1, currentlyCited: 0 },
    });
  }
  return signals;
}

/**
 * Link prospects that are contactable and clear the domain-rating floor.
 *
 * Uses link-building's own `minDomainRating`, so a prospect the outreach module
 * would reject never becomes an opportunity the loop tries to route to it.
 */
async function extractProspectReady(clientId: string): Promise<Signal[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.linkProspects.id,
      targetUrl: schema.linkProspects.targetUrl,
      domainRating: schema.linkProspects.domainRating,
      relevanceScore: schema.linkProspects.relevanceScore,
      contactEmail: schema.linkProspects.contactEmail,
      status: schema.linkProspects.status,
    })
    .from(schema.linkProspects)
    .where(
      and(
        eq(schema.linkProspects.clientId, clientId),
        eq(schema.linkProspects.status, "ready"),
        isNotNull(schema.linkProspects.contactEmail),
      ),
    );

  const signals: Signal[] = [];
  for (const row of rows) {
    const dr = row.domainRating;
    // A missing DR is not a passing DR. Unknown authority fails the floor.
    if (dr === null || dr < SAFETY.minDomainRating) continue;

    const subject = urlToPath(row.targetUrl) === "/" ? row.targetUrl : row.targetUrl;
    signals.push({
      clientId,
      signalType: "prospect_ready",
      fingerprint: signalFingerprint(clientId, "prospect_ready", subject),
      severity: "info",
      subject: normalizeSubject(subject).slice(0, 500),
      evidence: {
        domainRating: dr,
        minDomainRating: SAFETY.minDomainRating,
        relevanceScore: row.relevanceScore,
        // The contact address itself is deliberately NOT recorded here. The
        // outreach module already holds it; copying PII into an evidence blob
        // that reaches an LLM prompt and an operator API would spread it.
        hasContact: 1,
      },
    });
  }
  return signals;
}

/**
 * Derive every signal for ONE client and persist them idempotently.
 *
 * Returns the signals as written. Callers must not assume the count equals the
 * number of rows inserted — a second run over unchanged data returns the same
 * signals having inserted nothing.
 */
export async function extractSignals(
  clientId: string,
  options: { runId?: string; now?: Date } = {},
): Promise<Signal[]> {
  assertClientId(clientId);
  const now = options.now ?? new Date();
  const since = lookbackFrom(now);

  const groups = await Promise.all([
    extractKeywordDrops(clientId, since),
    extractBadLcpHighExit(clientId, since),
    extractCitationLoss(clientId, since),
    extractProspectReady(clientId),
  ]);
  const signals = groups.flat();

  // Belt and braces: nothing carrying another client's id can be written, even
  // if a future extractor forgot its WHERE clause.
  const foreign = signals.filter((s) => s.clientId !== clientId);
  if (foreign.length > 0) {
    throw new Error(
      `intelligence: refusing to write ${foreign.length} signal(s) scoped to another client`,
    );
  }

  await persistSignals(clientId, signals, now, options.runId);

  logger.info(
    { clientId, count: signals.length, types: [...new Set(signals.map((s) => s.signalType))] },
    "signals extracted",
  );
  return signals;
}

/**
 * Upsert on (client_id, fingerprint).
 *
 * `first_observed_at` and `status` are intentionally absent from the update
 * set: the first sighting is a historical fact, and an operator who suppressed
 * a signal should not have that undone by the next scheduled run.
 */
async function persistSignals(
  clientId: string,
  signals: Signal[],
  now: Date,
  runId?: string,
): Promise<void> {
  if (signals.length === 0) return;
  const db = getDb();

  for (const signal of signals) {
    await db
      .insert(schema.intelligenceSignals)
      .values({
        clientId,
        runId: runId ?? null,
        signalType: signal.signalType,
        fingerprint: signal.fingerprint,
        severity: signal.severity,
        subject: signal.subject,
        evidence: signal.evidence,
        status: "open",
        firstObservedAt: now,
        observedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.intelligenceSignals.clientId, schema.intelligenceSignals.fingerprint],
        set: {
          severity: signal.severity,
          evidence: signal.evidence,
          observedAt: now,
          runId: runId ?? null,
        },
        // Re-observing a signal must not resurrect one an operator suppressed.
        where: sql`${schema.intelligenceSignals.status} <> 'suppressed'`,
      });
  }
}
