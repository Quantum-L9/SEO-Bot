/* L9_META
 * layer: reporting
 * role: client_outcome_report_data
 * status: active
 * version: 1.0.0
 */

/**
 * Database side of the client outcome report: read the period's observations
 * (read-only, client-scoped) and persist / fetch weekly snapshots.
 *
 * Snapshots are stored as `job_executions` rows (`job_name =
 * reports:outcome-snapshot`, report in `metadata`). That table is already
 * migrated, client-scoped and append-style, so no schema migration is needed.
 * A snapshot is written once per (client, period): a re-run of the weekly job
 * for the same week finds the existing row and writes nothing.
 */

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb, schema } from "../core/database/index.js";
import {
  buildOutcomeReport,
  type OutcomeReport,
  type OutcomeReportInput,
  renderOutcomeReportMarkdown,
} from "./outcome-report.js";

export const OUTCOME_SNAPSHOT_JOB = "reports:outcome-snapshot";

/** Bound on pre-period rows read to find each series' starting point. */
const BEFORE_LIMIT = 1000;

export async function loadOutcomeReportInput(
  clientId: string,
  period: { from: Date; to: Date },
  now: Date = new Date(),
): Promise<OutcomeReportInput | null> {
  const db = getDb();
  const [client] = await db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      domain: schema.clients.domain,
      config: schema.clients.config,
    })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);
  if (!client) return null;

  const { from, to } = period;
  const rankingColumns = {
    keyword: schema.serpRankings.keyword,
    position: schema.serpRankings.position,
    url: schema.serpRankings.url,
    device: schema.serpRankings.device,
    checkedAt: schema.serpRankings.checkedAt,
  };
  const vitalsColumns = {
    url: schema.webVitals.url,
    source: schema.webVitals.source,
    device: schema.webVitals.device,
    lcp: schema.webVitals.lcp,
    inp: schema.webVitals.inp,
    cls: schema.webVitals.cls,
    rating: schema.webVitals.rating,
    measuredAt: schema.webVitals.measuredAt,
  };

  const [rankings, rankingsBefore, vitals, vitalsBefore, citations, llmUsage] = await Promise.all([
    db
      .select(rankingColumns)
      .from(schema.serpRankings)
      .where(
        and(
          eq(schema.serpRankings.clientId, clientId),
          gte(schema.serpRankings.checkedAt, from),
          lt(schema.serpRankings.checkedAt, to),
        ),
      ),
    db
      .select(rankingColumns)
      .from(schema.serpRankings)
      .where(
        and(eq(schema.serpRankings.clientId, clientId), lt(schema.serpRankings.checkedAt, from)),
      )
      .orderBy(desc(schema.serpRankings.checkedAt))
      .limit(BEFORE_LIMIT),
    db
      .select(vitalsColumns)
      .from(schema.webVitals)
      .where(
        and(
          eq(schema.webVitals.clientId, clientId),
          gte(schema.webVitals.measuredAt, from),
          lt(schema.webVitals.measuredAt, to),
        ),
      ),
    db
      .select(vitalsColumns)
      .from(schema.webVitals)
      .where(and(eq(schema.webVitals.clientId, clientId), lt(schema.webVitals.measuredAt, from)))
      .orderBy(desc(schema.webVitals.measuredAt))
      .limit(BEFORE_LIMIT),
    db
      .select({
        query: schema.aeoCitations.query,
        platform: schema.aeoCitations.platform,
        cited: schema.aeoCitations.cited,
        citedUrl: schema.aeoCitations.citedUrl,
        competitorCited: schema.aeoCitations.competitorCited,
        checkedAt: schema.aeoCitations.checkedAt,
      })
      .from(schema.aeoCitations)
      .where(
        and(
          eq(schema.aeoCitations.clientId, clientId),
          gte(schema.aeoCitations.checkedAt, from),
          lt(schema.aeoCitations.checkedAt, to),
        ),
      ),
    db
      .select({ module: schema.llmUsage.module, cost: schema.llmUsage.cost })
      .from(schema.llmUsage)
      .where(
        and(
          eq(schema.llmUsage.clientId, clientId),
          gte(schema.llmUsage.timestamp, from),
          lt(schema.llmUsage.timestamp, to),
        ),
      ),
  ]);

  return {
    client,
    period,
    generatedAt: now,
    rankings,
    rankingsBefore,
    vitals,
    vitalsBefore,
    citations,
    llmUsage,
  };
}

export interface OutcomeSnapshot {
  report: OutcomeReport;
  markdown: string;
  storedAt: string;
}

interface SnapshotMetadata {
  kind: "outcome_report";
  periodFrom: string;
  periodTo: string;
  report: OutcomeReport;
  markdown: string;
}

function isSnapshotMetadata(value: unknown): value is SnapshotMetadata {
  const m = value as Partial<SnapshotMetadata> | null;
  return !!m && m.kind === "outcome_report" && typeof m.markdown === "string" && !!m.report;
}

/**
 * Build and persist the snapshot for one client and period. Returns
 * `created: false` when a snapshot for that exact period already exists.
 */
export async function persistOutcomeSnapshot(
  clientId: string,
  period: { from: Date; to: Date },
  now: Date = new Date(),
): Promise<{ created: boolean; report: OutcomeReport | null }> {
  const db = getDb();
  const periodFrom = period.from.toISOString();
  const [existing] = await db
    .select({ id: schema.jobExecutions.id })
    .from(schema.jobExecutions)
    .where(
      and(
        eq(schema.jobExecutions.jobName, OUTCOME_SNAPSHOT_JOB),
        eq(schema.jobExecutions.clientId, clientId),
        sql`${schema.jobExecutions.metadata}->>'periodFrom' = ${periodFrom}`,
      ),
    )
    .limit(1);
  if (existing) return { created: false, report: null };

  const input = await loadOutcomeReportInput(clientId, period, now);
  if (!input) return { created: false, report: null };
  const report = buildOutcomeReport(input);
  const metadata: SnapshotMetadata = {
    kind: "outcome_report",
    periodFrom,
    periodTo: period.to.toISOString(),
    report,
    markdown: renderOutcomeReportMarkdown(report),
  };
  await db.insert(schema.jobExecutions).values({
    jobName: OUTCOME_SNAPSHOT_JOB,
    clientId,
    status: "completed",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    metadata,
  });
  return { created: true, report };
}

export async function loadLatestOutcomeSnapshot(clientId: string): Promise<OutcomeSnapshot | null> {
  const [row] = await getDb()
    .select({ metadata: schema.jobExecutions.metadata, startedAt: schema.jobExecutions.startedAt })
    .from(schema.jobExecutions)
    .where(
      and(
        eq(schema.jobExecutions.jobName, OUTCOME_SNAPSHOT_JOB),
        eq(schema.jobExecutions.clientId, clientId),
      ),
    )
    .orderBy(desc(schema.jobExecutions.startedAt))
    .limit(1);
  if (!row || !isSnapshotMetadata(row.metadata)) return null;
  return {
    report: row.metadata.report,
    markdown: row.metadata.markdown,
    storedAt: row.startedAt.toISOString(),
  };
}
