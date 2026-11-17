import { describe, expect, it } from "vitest";
import {
  buildOutcomeReport,
  OUTCOME_REPORT_SCHEMA,
  type OutcomeReportInput,
  previousWeekPeriod,
  renderOutcomeReportMarkdown,
} from "../../src/reporting/outcome-report.js";

const from = new Date("2026-11-09T00:00:00.000Z");
const to = new Date("2026-11-16T00:00:00.000Z");
const d = (iso: string) => new Date(iso);

function emptyInput(config: unknown = {}): OutcomeReportInput {
  return {
    client: { id: "c-1", name: "Quantum AI Partners", domain: "quantumaipartners.com", config },
    period: { from, to },
    generatedAt: d("2026-11-16T07:00:00.000Z"),
    rankings: [],
    rankingsBefore: [],
    vitals: [],
    vitalsBefore: [],
    citations: [],
    llmUsage: [],
  };
}

function populatedInput(): OutcomeReportInput {
  const input = emptyInput({
    canonicalClientId: "quantumaipartners_com",
    targetKeywords: [
      { keyword: "ai consulting", priority: "high" },
      { keyword: "ai strategy partner", priority: "medium" },
      { keyword: "llm integration", priority: "low" },
    ],
  });
  const rk = (keyword: string, position: number | null, at: string) => ({
    keyword,
    position,
    url: position === null ? null : "https://quantumaipartners.com/",
    device: "desktop",
    checkedAt: d(at),
  });
  input.rankingsBefore = [
    rk("ai consulting", 14, "2026-11-08T06:00:00Z"),
    rk("ai consulting", 18, "2026-11-01T06:00:00Z"),
  ];
  input.rankings = [
    rk("ai consulting", 11, "2026-11-10T06:00:00Z"),
    rk("ai consulting", 9, "2026-11-15T06:00:00Z"),
    rk("ai strategy partner", null, "2026-11-10T06:00:00Z"),
    rk("ai strategy partner", 42, "2026-11-15T06:00:00Z"),
  ];
  input.vitalsBefore = [
    {
      url: "https://quantumaipartners.com",
      source: "psi",
      device: "mobile",
      lcp: 3100,
      inp: 240,
      cls: 0.12,
      rating: "needs-improvement",
      measuredAt: d("2026-11-08T18:00:00Z"),
    },
  ];
  input.vitals = [
    {
      url: "https://quantumaipartners.com",
      source: "psi",
      device: "mobile",
      lcp: 2900,
      inp: 210,
      cls: 0.1,
      rating: "needs-improvement",
      measuredAt: d("2026-11-10T00:00:00Z"),
    },
    {
      url: "https://quantumaipartners.com",
      source: "psi",
      device: "mobile",
      lcp: 2200,
      inp: 180,
      cls: 0.05,
      rating: "good",
      measuredAt: d("2026-11-15T18:00:00Z"),
    },
  ];
  input.citations = [
    {
      query: "best ai consulting firm",
      platform: "perplexity",
      cited: true,
      citedUrl: "https://quantumaipartners.com/",
      competitorCited: null,
      checkedAt: d("2026-11-11T09:00:00Z"),
    },
    {
      query: "ai strategy partner",
      platform: "perplexity",
      cited: false,
      citedUrl: null,
      competitorCited: "rival.ai",
      checkedAt: d("2026-11-11T09:00:00Z"),
    },
    {
      query: "best ai consulting firm",
      platform: "chatgpt",
      cited: false,
      citedUrl: null,
      competitorCited: null,
      checkedAt: d("2026-11-11T09:00:00Z"),
    },
  ];
  input.llmUsage = [
    { module: "aeo-geo", cost: 0.0123 },
    { module: "aeo-geo", cost: 0.004 },
    { module: "serp-intelligence", cost: 0.05 },
  ];
  return input;
}

describe("buildOutcomeReport — populated period", () => {
  const report = buildOutcomeReport(populatedInput());

  it("identifies the report and client", () => {
    expect(report.schema).toBe(OUTCOME_REPORT_SCHEMA);
    expect(report.client).toEqual({
      id: "c-1",
      canonicalClientId: "quantumaipartners_com",
      name: "Quantum AI Partners",
      domain: "quantumaipartners.com",
    });
    expect(report.period).toEqual({ from: from.toISOString(), to: to.toISOString() });
  });

  it("computes keyword deltas from the last pre-period observation", () => {
    expect(report.rankings.status).toBe("ok");
    const byKw = Object.fromEntries(
      (report.rankings.data?.keywords ?? []).map((k) => [k.keyword, k]),
    );
    expect(byKw["ai consulting"]).toMatchObject({
      status: "ranking",
      position: 9,
      startPosition: 14,
      delta: 5,
      tracked: true,
      priority: "high",
      observations: 2,
    });
    // No pre-period data: start is the first in-period check, which was unranked.
    expect(byKw["ai strategy partner"]).toMatchObject({
      status: "ranking",
      position: 42,
      startPosition: null,
      delta: null,
    });
    // Tracked but never checked: reported honestly, never estimated.
    expect(byKw["llm integration"]).toMatchObject({
      status: "no_data",
      position: null,
      startPosition: null,
      delta: null,
      observations: 0,
    });
    expect(report.rankings.data?.summary).toEqual({
      keywords: 3,
      withData: 2,
      improved: 1,
      declined: 0,
      unchanged: 0,
      enteredResults: 1,
      leftResults: 0,
    });
  });

  it("reports the latest Core Web Vitals with the pre-period comparison", () => {
    expect(report.coreWebVitals.status).toBe("ok");
    expect(report.coreWebVitals.data?.measurements).toEqual([
      {
        url: "https://quantumaipartners.com",
        source: "psi",
        device: "mobile",
        lcpMs: 2200,
        inpMs: 180,
        cls: 0.05,
        rating: "good",
        measuredAt: "2026-11-15T18:00:00.000Z",
        previous: { lcpMs: 3100, inpMs: 240, cls: 0.12, measuredAt: "2026-11-08T18:00:00.000Z" },
      },
    ]);
  });

  it("aggregates AI citation checks by platform", () => {
    expect(report.aiCitations.status).toBe("ok");
    expect(report.aiCitations.data).toMatchObject({
      checks: 3,
      cited: 1,
      citationRatePct: 33.3,
      byPlatform: [
        { platform: "chatgpt", checks: 1, cited: 0 },
        { platform: "perplexity", checks: 2, cited: 1 },
      ],
    });
  });

  it("sums recorded LLM spend and states what it excludes", () => {
    expect(report.spend.status).toBe("ok");
    expect(report.spend.data).toEqual({
      llmUsd: 0.0663,
      llmCalls: 3,
      byModule: [
        { module: "aeo-geo", usd: 0.0163, calls: 2 },
        { module: "serp-intelligence", usd: 0.05, calls: 1 },
      ],
    });
    expect(report.spend.note).toMatch(/not metered/);
  });

  it("never invents leads", () => {
    expect(report.leads).toMatchObject({ status: "no_data", data: null });
    expect(report.leads.note).toMatch(/No data yet/);
  });

  it("renders a markdown summary with every section and its source", () => {
    const md = renderOutcomeReportMarkdown(report);
    expect(md).toContain("# SEO outcome report — quantumaipartners.com");
    expect(md).toContain("| ai consulting | 9 | 14 | ▲ 5 | ranking |");
    expect(md).toContain("| llm integration | — | — | — | no data yet |");
    expect(md).toContain("Cited in 1 of 3 checks (33.3%).");
    expect(md).toContain("LLM spend: $0.0663 across 3 calls.");
    for (const section of [
      report.rankings,
      report.coreWebVitals,
      report.aiCitations,
      report.leads,
      report.spend,
    ]) {
      expect(md).toContain(`_Source: ${section.source}_`);
    }
  });
});

describe("buildOutcomeReport — no data yet", () => {
  it("marks every section no_data with a reason and no fabricated numbers", () => {
    const report = buildOutcomeReport(emptyInput());
    for (const section of [
      report.rankings,
      report.coreWebVitals,
      report.aiCitations,
      report.leads,
      report.spend,
    ]) {
      expect(section.status).toBe("no_data");
      expect(section.data).toBeNull();
      expect(section.note).toMatch(/No data yet|No LLM usage/);
      expect(section.source.length).toBeGreaterThan(0);
    }
    expect(report.client.canonicalClientId).toBeNull();
    const md = renderOutcomeReportMarkdown(report);
    expect(md).not.toMatch(/\| \d/);
    expect(md).toContain(
      "> No data yet: no Core Web Vitals measurement was stored for this period.",
    );
  });

  it("still lists tracked keywords, each as no data yet", () => {
    const report = buildOutcomeReport(
      emptyInput({ targetKeywords: [{ keyword: "ai consulting", priority: "high" }] }),
    );
    expect(report.rankings.status).toBe("no_data");
    expect(report.rankings.data?.keywords).toEqual([
      expect.objectContaining({
        keyword: "ai consulting",
        status: "no_data",
        position: null,
        delta: null,
      }),
    ]);
  });
});

describe("previousWeekPeriod", () => {
  it("returns the closed Monday-to-Monday UTC week", () => {
    expect(previousWeekPeriod(d("2026-11-16T07:00:00Z"))).toEqual({ from, to });
    expect(previousWeekPeriod(d("2026-11-22T23:59:59Z"))).toEqual({ from, to });
  });
});
