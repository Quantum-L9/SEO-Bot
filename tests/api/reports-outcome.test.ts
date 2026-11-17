import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/database/index.js", () => ({ getDb: vi.fn(), schema: {} }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { registerOutcomeReportRoutes } from "../../src/api/reports/outcome.js";
import {
  buildOutcomeReport,
  type OutcomeReportInput,
  renderOutcomeReportMarkdown,
} from "../../src/reporting/outcome-report.js";
import { runOutcomeReportJob } from "../../src/reporting/outcome-report-job.js";

const CLIENT = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-11-17T10:00:00.000Z");

function input(period: { from: Date; to: Date }): OutcomeReportInput {
  return {
    client: {
      id: CLIENT,
      name: "Quantum AI Partners",
      domain: "quantumaipartners.com",
      config: {},
    },
    period,
    generatedAt: NOW,
    rankings: [],
    rankingsBefore: [],
    vitals: [],
    vitalsBefore: [],
    citations: [
      {
        query: "q",
        platform: "perplexity",
        cited: true,
        citedUrl: null,
        competitorCited: null,
        checkedAt: NOW,
      },
    ],
    llmUsage: [],
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(deps: Parameters<typeof registerOutcomeReportRoutes>[1]) {
  app = Fastify();
  await registerOutcomeReportRoutes(app, { now: () => NOW, ...deps });
  await app.ready();
  return app;
}

describe("GET /api/reports/clients/:clientId/outcome", () => {
  it("defaults to the 7 days ending now and returns JSON + markdown", async () => {
    const loadInput = vi.fn(async (_id: string, period: { from: Date; to: Date }) => input(period));
    const server = await build({ loadInput });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${CLIENT}/outcome`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.period).toEqual({ from: "2026-11-10T10:00:00.000Z", to: NOW.toISOString() });
    expect(body.report.aiCitations.status).toBe("ok");
    expect(body.report.rankings.status).toBe("no_data");
    expect(body.markdown).toContain("# SEO outcome report — quantumaipartners.com");
    expect(loadInput).toHaveBeenCalledWith(CLIENT, expect.any(Object), NOW);
  });

  it("serves text/markdown on format=markdown with an explicit period", async () => {
    const server = await build({ loadInput: async (_id, period) => input(period) });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${CLIENT}/outcome?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z&format=markdown`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("2026-11-01T00:00:00.000Z → 2026-11-08T00:00:00.000Z");
  });

  it.each([
    ["not-a-uuid", "", 400],
    [CLIENT, "?from=yesterday", 400],
    [CLIENT, "?from=2026-11-08T00:00:00Z&to=2026-11-01T00:00:00Z", 400],
    [CLIENT, "?from=2026-01-01T00:00:00Z&to=2026-11-01T00:00:00Z", 400],
    [CLIENT, "?format=pdf", 400],
  ])("rejects invalid input %s%s", async (id, qs, status) => {
    const loadInput = vi.fn();
    const server = await build({ loadInput });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${id}/outcome${qs}`,
    });
    expect(res.statusCode).toBe(status);
    expect(loadInput).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown client", async () => {
    const server = await build({ loadInput: async () => null });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${CLIENT}/outcome`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/reports/clients/:clientId/outcome/latest", () => {
  it("returns the stored weekly snapshot", async () => {
    const report = buildOutcomeReport(
      input({ from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") }),
    );
    const server = await build({
      loadLatest: async () => ({
        report,
        markdown: renderOutcomeReportMarkdown(report),
        storedAt: NOW.toISOString(),
      }),
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${CLIENT}/outcome/latest`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      storedAt: NOW.toISOString(),
      report: { period: report.period },
    });
  });

  it("says honestly that no snapshot exists yet", async () => {
    const server = await build({ loadLatest: async () => null });
    const res = await server.inject({
      method: "GET",
      url: `/api/reports/clients/${CLIENT}/outcome/latest`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no weekly outcome report stored yet");
  });
});

describe("reports:outcome-weekly job", () => {
  it("snapshots the previous closed week for the fanned-out client", async () => {
    const persist = vi.fn(async () => ({ created: true, report: null }));
    await runOutcomeReportJob({ data: { clientId: CLIENT } }, () => NOW, persist);
    expect(persist).toHaveBeenCalledWith(
      CLIENT,
      { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") },
      NOW,
    );
  });

  it("does nothing for the un-fanned parent job (no clientId)", async () => {
    const persist = vi.fn();
    await runOutcomeReportJob({ data: {} }, () => NOW, persist);
    expect(persist).not.toHaveBeenCalled();
  });
});
