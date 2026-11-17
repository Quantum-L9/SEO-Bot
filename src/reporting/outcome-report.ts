/* L9_META
 * layer: reporting
 * role: client_outcome_report
 * status: active
 * version: 1.0.0
 */

/**
 * Client outcome report — the client-visible proof of value.
 *
 * Pure: `buildOutcomeReport` takes rows already loaded for one client and one
 * period and returns a JSON report; `renderOutcomeReportMarkdown` renders it.
 * Loading lives in `outcome-report-data.ts`, so both halves test without a DB.
 *
 * Honesty contract (every section):
 *   - `source` names where the numbers come from;
 *   - `status` is `ok` only when stored observations exist for the period,
 *     otherwise `no_data` with a `note` saying why;
 *   - nothing is estimated, interpolated or defaulted. A missing value is
 *     `null`, never 0.
 */

export const OUTCOME_REPORT_SCHEMA = "l9.seo-bot.outcome-report.v1" as const;

// ─── Input rows (shape of the stored observations) ───────────────────────────

export interface ReportClient {
  id: string;
  name: string;
  domain: string;
  config: unknown;
}

export interface RankingObservation {
  keyword: string;
  position: number | null;
  url: string | null;
  device: string | null;
  checkedAt: Date;
}

export interface VitalsObservation {
  url: string;
  source: string;
  device: string | null;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  rating: string | null;
  measuredAt: Date;
}

export interface CitationObservation {
  query: string;
  platform: string;
  cited: boolean;
  citedUrl: string | null;
  competitorCited: string | null;
  checkedAt: Date;
}

export interface LlmUsageObservation {
  module: string;
  cost: number;
}

export interface OutcomeReportInput {
  client: ReportClient;
  period: { from: Date; to: Date };
  generatedAt: Date;
  /** Observations inside [from, to). */
  rankings: RankingObservation[];
  /** Observations before `from` — newest first is not required. */
  rankingsBefore: RankingObservation[];
  vitals: VitalsObservation[];
  vitalsBefore: VitalsObservation[];
  citations: CitationObservation[];
  llmUsage: LlmUsageObservation[];
}

// ─── Output ──────────────────────────────────────────────────────────────────

export type SectionStatus = "ok" | "no_data";

export interface ReportSection<T> {
  source: string;
  status: SectionStatus;
  note?: string;
  data: T | null;
}

export interface KeywordOutcome {
  keyword: string;
  /** Present when the keyword is in the client's tracked target list. */
  priority: string | null;
  tracked: boolean;
  status: "no_data" | "ranking" | "not_in_results";
  /** Latest observed position in the period; null = not found in the checked results. */
  position: number | null;
  /** Position at the start of the period (last observation before it, else first in it). */
  startPosition: number | null;
  /** startPosition − position. Positive = moved up. Null when either end is unranked/unknown. */
  delta: number | null;
  url: string | null;
  lastCheckedAt: string | null;
  observations: number;
}

export interface VitalsOutcome {
  url: string;
  source: string;
  device: string | null;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  rating: string | null;
  measuredAt: string;
  previous: {
    lcpMs: number | null;
    inpMs: number | null;
    cls: number | null;
    measuredAt: string;
  } | null;
}

export interface CitationOutcome {
  checks: number;
  cited: number;
  citationRatePct: number;
  byPlatform: Array<{ platform: string; checks: number; cited: number }>;
  queries: Array<{
    query: string;
    platform: string;
    cited: boolean;
    citedUrl: string | null;
    competitorCited: string | null;
    checkedAt: string;
  }>;
}

export interface SpendOutcome {
  llmUsd: number;
  llmCalls: number;
  byModule: Array<{ module: string; usd: number; calls: number }>;
}

export interface OutcomeReport {
  schema: typeof OUTCOME_REPORT_SCHEMA;
  client: { id: string; canonicalClientId: string | null; name: string; domain: string };
  period: { from: string; to: string };
  generatedAt: string;
  rankings: ReportSection<{
    summary: {
      keywords: number;
      withData: number;
      improved: number;
      declined: number;
      unchanged: number;
      enteredResults: number;
      leftResults: number;
    };
    keywords: KeywordOutcome[];
  }>;
  coreWebVitals: ReportSection<{ measurements: VitalsOutcome[] }>;
  aiCitations: ReportSection<CitationOutcome>;
  leads: ReportSection<{ leads: number }>;
  spend: ReportSection<SpendOutcome>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function trackedKeywords(config: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const list = record(config).targetKeywords;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const kw = record(item).keyword;
    if (typeof kw !== "string" || !kw.trim()) continue;
    const priority = record(item).priority;
    out.set(kw, typeof priority === "string" ? priority : null);
  }
  return out;
}

function byTime<T>(get: (row: T) => Date) {
  return (a: T, b: T) => get(a).getTime() - get(b).getTime();
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// ─── Sections ────────────────────────────────────────────────────────────────

function rankingsSection(input: OutcomeReportInput): OutcomeReport["rankings"] {
  const source = "serp_rankings (DataForSEO SERP checks, job serp:check-rankings)";
  const tracked = trackedKeywords(input.client.config);
  const inPeriod = new Map<string, RankingObservation[]>();
  for (const row of input.rankings) {
    const list = inPeriod.get(row.keyword) ?? [];
    list.push(row);
    inPeriod.set(row.keyword, list);
  }
  const lastBefore = new Map<string, RankingObservation>();
  for (const row of [...input.rankingsBefore].sort(byTime((r) => r.checkedAt))) {
    lastBefore.set(row.keyword, row);
  }

  const keywordNames = [...new Set([...tracked.keys(), ...inPeriod.keys()])].sort();
  const keywords: KeywordOutcome[] = keywordNames.map((keyword) => {
    const rows = (inPeriod.get(keyword) ?? []).sort(byTime((r) => r.checkedAt));
    const base: Omit<KeywordOutcome, "status" | "position" | "startPosition" | "delta"> = {
      keyword,
      priority: tracked.get(keyword) ?? null,
      tracked: tracked.has(keyword),
      url: null,
      lastCheckedAt: null,
      observations: rows.length,
    };
    if (rows.length === 0) {
      return { ...base, status: "no_data", position: null, startPosition: null, delta: null };
    }
    const latest = rows[rows.length - 1];
    const start = lastBefore.get(keyword) ?? rows[0];
    const delta =
      latest.position !== null && start.position !== null ? start.position - latest.position : null;
    return {
      ...base,
      status: latest.position === null ? "not_in_results" : "ranking",
      position: latest.position,
      startPosition: start.position,
      delta,
      url: latest.url,
      lastCheckedAt: latest.checkedAt.toISOString(),
    };
  });

  const withData = keywords.filter((k) => k.status !== "no_data");
  if (withData.length === 0) {
    return {
      source,
      status: "no_data",
      note:
        tracked.size === 0
          ? "No data yet: no target keywords are configured and no ranking checks were stored for this period."
          : "No data yet: no ranking check was stored for this period. Tracked keywords are listed with status no_data.",
      data: keywords.length
        ? {
            summary: {
              keywords: keywords.length,
              withData: 0,
              improved: 0,
              declined: 0,
              unchanged: 0,
              enteredResults: 0,
              leftResults: 0,
            },
            keywords,
          }
        : null,
    };
  }
  return {
    source,
    status: "ok",
    data: {
      summary: {
        keywords: keywords.length,
        withData: withData.length,
        improved: withData.filter((k) => k.delta !== null && k.delta > 0).length,
        declined: withData.filter((k) => k.delta !== null && k.delta < 0).length,
        unchanged: withData.filter((k) => k.delta === 0).length,
        enteredResults: withData.filter((k) => k.startPosition === null && k.position !== null)
          .length,
        leftResults: withData.filter((k) => k.startPosition !== null && k.position === null).length,
      },
      keywords,
    },
  };
}

function vitalsKey(row: VitalsObservation): string {
  return `${row.url}|${row.source}|${row.device ?? ""}`;
}

function vitalsSection(input: OutcomeReportInput): OutcomeReport["coreWebVitals"] {
  const source = "web_vitals (PageSpeed Insights, CrUX, PostHog RUM; job vitals:check-all-sources)";
  if (input.vitals.length === 0) {
    return {
      source,
      status: "no_data",
      note: "No data yet: no Core Web Vitals measurement was stored for this period.",
      data: null,
    };
  }
  const latest = new Map<string, VitalsObservation>();
  for (const row of [...input.vitals].sort(byTime((r) => r.measuredAt)))
    latest.set(vitalsKey(row), row);
  const previous = new Map<string, VitalsObservation>();
  for (const row of [...input.vitalsBefore].sort(byTime((r) => r.measuredAt)))
    previous.set(vitalsKey(row), row);

  const measurements: VitalsOutcome[] = [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => {
      const prev = previous.get(key);
      return {
        url: row.url,
        source: row.source,
        device: row.device,
        lcpMs: row.lcp,
        inpMs: row.inp,
        cls: row.cls,
        rating: row.rating,
        measuredAt: row.measuredAt.toISOString(),
        previous: prev
          ? {
              lcpMs: prev.lcp,
              inpMs: prev.inp,
              cls: prev.cls,
              measuredAt: prev.measuredAt.toISOString(),
            }
          : null,
      };
    });
  return { source, status: "ok", data: { measurements } };
}

function citationsSection(input: OutcomeReportInput): OutcomeReport["aiCitations"] {
  const source = "aeo_citations (AI answer-engine checks, job aeo:check-citations)";
  if (input.citations.length === 0) {
    return {
      source,
      status: "no_data",
      note: "No data yet: no AEO/GEO citation check was stored for this period.",
      data: null,
    };
  }
  const platforms = new Map<string, { checks: number; cited: number }>();
  for (const row of input.citations) {
    const p = platforms.get(row.platform) ?? { checks: 0, cited: 0 };
    p.checks += 1;
    if (row.cited) p.cited += 1;
    platforms.set(row.platform, p);
  }
  const cited = input.citations.filter((c) => c.cited).length;
  return {
    source,
    status: "ok",
    data: {
      checks: input.citations.length,
      cited,
      citationRatePct: round((cited / input.citations.length) * 100, 1),
      byPlatform: [...platforms.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([platform, p]) => ({ platform, ...p })),
      queries: [...input.citations].sort(byTime((r) => r.checkedAt)).map((c) => ({
        query: c.query,
        platform: c.platform,
        cited: c.cited,
        citedUrl: c.citedUrl,
        competitorCited: c.competitorCited,
        checkedAt: c.checkedAt.toISOString(),
      })),
    },
  };
}

function leadsSection(): OutcomeReport["leads"] {
  return {
    source: "PostHog / site form submissions",
    status: "no_data",
    note:
      "No data yet: SEO-Bot does not ingest form-submission or lead events. PostHog data stored " +
      "here (page_engagement) is traffic and engagement aggregates only, so no lead count is reported.",
    data: null,
  };
}

function spendSection(input: OutcomeReportInput): OutcomeReport["spend"] {
  const source = "llm_usage (LLM cost recorded per call by SEO-Bot)";
  const scopeNote =
    "Covers LLM spend only. DataForSEO, PageSpeed and other third-party API costs are not metered per client.";
  if (input.llmUsage.length === 0) {
    return {
      source,
      status: "no_data",
      note: `No LLM usage was recorded for this client in this period. ${scopeNote}`,
      data: null,
    };
  }
  const modules = new Map<string, { usd: number; calls: number }>();
  let total = 0;
  for (const row of input.llmUsage) {
    const m = modules.get(row.module) ?? { usd: 0, calls: 0 };
    m.usd += row.cost;
    m.calls += 1;
    modules.set(row.module, m);
    total += row.cost;
  }
  return {
    source,
    status: "ok",
    note: scopeNote,
    data: {
      llmUsd: round(total, 4),
      llmCalls: input.llmUsage.length,
      byModule: [...modules.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([module, m]) => ({ module, usd: round(m.usd, 4), calls: m.calls })),
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function buildOutcomeReport(input: OutcomeReportInput): OutcomeReport {
  const canonical = record(input.client.config).canonicalClientId;
  return {
    schema: OUTCOME_REPORT_SCHEMA,
    client: {
      id: input.client.id,
      canonicalClientId: typeof canonical === "string" ? canonical : null,
      name: input.client.name,
      domain: input.client.domain,
    },
    period: { from: input.period.from.toISOString(), to: input.period.to.toISOString() },
    generatedAt: input.generatedAt.toISOString(),
    rankings: rankingsSection(input),
    coreWebVitals: vitalsSection(input),
    aiCitations: citationsSection(input),
    leads: leadsSection(),
    spend: spendSection(input),
  };
}

function cell(value: number | string | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

function sectionHeader<T>(title: string, section: ReportSection<T>): string[] {
  const lines = [`## ${title}`, "", `_Source: ${section.source}_`, ""];
  if (section.note) lines.push(`> ${section.note}`, "");
  return lines;
}

export function renderOutcomeReportMarkdown(report: OutcomeReport): string {
  const lines: string[] = [
    `# SEO outcome report — ${report.client.domain}`,
    "",
    `**Client:** ${report.client.name}  `,
    `**Period:** ${report.period.from} → ${report.period.to}  `,
    `**Generated:** ${report.generatedAt}`,
    "",
  ];

  lines.push(...sectionHeader("Keyword rankings", report.rankings));
  const rk = report.rankings.data;
  if (rk) {
    if (report.rankings.status === "ok") {
      const s = rk.summary;
      lines.push(
        `${s.withData}/${s.keywords} keywords checked · ${s.improved} improved · ${s.declined} declined · ` +
          `${s.unchanged} unchanged · ${s.enteredResults} entered results · ${s.leftResults} left results`,
        "",
      );
    }
    lines.push("| Keyword | Position | Start | Change | Status |", "|---|---|---|---|---|");
    for (const k of rk.keywords) {
      const change =
        k.delta === null ? "—" : k.delta > 0 ? `▲ ${k.delta}` : k.delta < 0 ? `▼ ${-k.delta}` : "0";
      const status =
        k.status === "no_data"
          ? "no data yet"
          : k.status === "not_in_results"
            ? "not in results"
            : "ranking";
      lines.push(
        `| ${k.keyword} | ${cell(k.position)} | ${cell(k.startPosition)} | ${change} | ${status} |`,
      );
    }
    lines.push("");
  }

  lines.push(...sectionHeader("Core Web Vitals", report.coreWebVitals));
  const cwv = report.coreWebVitals.data;
  if (cwv) {
    lines.push(
      "| URL | Source | Device | LCP (ms) | INP (ms) | CLS | Rating | Previous LCP / INP / CLS |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const m of cwv.measurements) {
      const prev = m.previous
        ? `${cell(m.previous.lcpMs)} / ${cell(m.previous.inpMs)} / ${cell(m.previous.cls)}`
        : "no earlier data";
      lines.push(
        `| ${m.url} | ${m.source} | ${cell(m.device)} | ${cell(m.lcpMs)} | ${cell(m.inpMs)} | ${cell(m.cls)} | ${cell(m.rating)} | ${prev} |`,
      );
    }
    lines.push("");
  }

  lines.push(...sectionHeader("AI answer-engine citations (AEO/GEO)", report.aiCitations));
  const ai = report.aiCitations.data;
  if (ai) {
    lines.push(`Cited in ${ai.cited} of ${ai.checks} checks (${ai.citationRatePct}%).`, "");
    lines.push("| Platform | Checks | Cited |", "|---|---|---|");
    for (const p of ai.byPlatform) lines.push(`| ${p.platform} | ${p.checks} | ${p.cited} |`);
    lines.push("");
  }

  lines.push(...sectionHeader("Leads", report.leads));
  if (report.leads.data) lines.push(`${report.leads.data.leads} leads.`, "");

  lines.push(...sectionHeader("SEO-Bot spend", report.spend));
  const sp = report.spend.data;
  if (sp) {
    lines.push(`LLM spend: $${sp.llmUsd.toFixed(4)} across ${sp.llmCalls} calls.`, "");
    lines.push("| Module | USD | Calls |", "|---|---|---|");
    for (const m of sp.byModule) lines.push(`| ${m.module} | ${m.usd.toFixed(4)} | ${m.calls} |`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** The closed ISO week (Mon 00:00 UTC → Mon 00:00 UTC) before `now`. */
export function previousWeekPeriod(now: Date): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (to.getUTCDay() + 6) % 7;
  to.setUTCDate(to.getUTCDate() - daysSinceMonday);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 7);
  return { from, to };
}
