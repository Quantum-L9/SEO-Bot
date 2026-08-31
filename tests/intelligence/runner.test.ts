/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The runner is what makes the plane's record durable and JOINABLE. Each row it
 * writes points at the one before it: a decision names the opportunity it acted
 * on, an experiment names the decision that opened it. Those links are the only
 * way an operator answers "why did the bot do that?" months later.
 *
 * They are also the easiest thing to lose: passing `null` for a foreign key
 * compiles, type-checks, and produces a database full of orphan rows that looks
 * completely healthy. So the links are asserted directly here, along with the
 * ordering that produces them and the boundary the plane must not cross —
 * queueing only allow-listed jobs, and opening no measurement window for work
 * that was merely proposed.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

/** Identifiable table handles so the mock can tell inserts apart. */
const tables = vi.hoisted(() => ({
  clients: { __table: "clients", id: "clients.id", active: "clients.active" },
  intelligenceRuns: { __table: "runs", id: "runs.id" },
  intelligenceSignals: {
    __table: "signals",
    clientId: "signals.client_id",
    fingerprint: "signals.fingerprint",
    observedAt: "signals.observed_at",
  },
  intelligenceOpportunities: {
    __table: "opportunities",
    id: "opportunities.id",
    runId: "opportunities.run_id",
    clientId: "opportunities.client_id",
    status: "opportunities.status",
    fingerprint: "opportunities.fingerprint",
  },
  intelligenceDecisions: { __table: "decisions", id: "decisions.id" },
  intelligenceExperiments: { __table: "experiments", id: "experiments.id" },
  intelligencePolicyState: { __table: "policy_state", clientId: "policy_state.client_id" },
  actionOutcomes: { __table: "action_outcomes", id: "action_outcomes.id" },
  actionLog: { __table: "action_log", id: "action_log.id" },
}));

const db = vi.hoisted(() => ({
  inserts: [] as { table: string; values: unknown }[],
  updates: [] as { table: string; values: unknown }[],
  /** Rows the next update() should return, consumed FIFO. Empty = guard rejected. */
  updateReturns: [] as unknown[],
  /** Queued results for select(), consumed FIFO. */
  selectQueue: [] as unknown[],
  /** Rows returned per extractor/policy query, matched on SQL text. */
  executeRows: new Map<string, Record<string, unknown>[]>(),
  executed: [] as string[],
}));

vi.mock("../../src/core/database/index.js", () => {
  const dialect = new PgDialect();

  const thenable = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const method of ["from", "where", "orderBy", "limit"]) p[method] = () => p;
    return p;
  };

  const makeDb = () => ({
    insert: (table: { __table: string }) => ({
      values: (values: unknown) => {
        const record = { table: table.__table, values };
        const settle = <T>(value: T) => {
          db.inserts.push(record);
          return Promise.resolve(value);
        };
        return {
          returning: () => settle([{ id: `${table.__table}-id-${db.inserts.length + 1}` }]),
          onConflictDoNothing: () => settle([]),
          onConflictDoUpdate: () => ({
            returning: () =>
              settle([
                {
                  autonomousActionsPaused: false,
                  pauseReason: null,
                  ...(values as Record<string, unknown>),
                },
              ]),
          }),
        };
      },
    }),
    update: (table: { __table: string }) => ({
      set: (values: unknown) => ({
        where: () => {
          db.updates.push({ table: table.__table, values });
          // An update result is consumed either directly (`await`) or through
          // `.returning()`. The guarded lifecycle transitions need the latter:
          // returning zero rows is how they tell "the row moved" from "the
          // status guard rejected it", so a mock that only resolved to []
          // would make every transition look like a no-op.
          const rows = db.updateReturns.shift() ?? [{ id: `${table.__table}-updated` }];
          const settled = Promise.resolve(rows) as Promise<unknown> & {
            returning: () => Promise<unknown>;
          };
          settled.returning = () => Promise.resolve(rows);
          return settled;
        },
      }),
    }),
    select: () => thenable(db.selectQueue.shift() ?? []),
    execute: (statement: never) => {
      const { sql } = dialect.sqlToQuery(statement);
      db.executed.push(sql);
      for (const [needle, rows] of db.executeRows) {
        if (sql.includes(needle)) return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
  });

  const instance = makeDb();
  return { getDb: () => instance, schema: tables };
});

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    DEFAULT_CLIENT_MONTHLY_BUDGET: 200,
    DAILY_SPEND_CAP: 10,
    INTELLIGENCE_MIN_OPPORTUNITY_SCORE: 20,
    INTELLIGENCE_MAX_ACTIONS_PER_RUN: 3,
    INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
    INTELLIGENCE_BASELINE_DAYS: 14,
    INTELLIGENCE_MEASUREMENT_DAYS: 28,
  }),
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { attributionEntity, runClientTriage } from "../../src/intelligence/runner.js";
import type { ScoredOpportunity } from "../../src/intelligence/types.js";

const addJob = vi.fn().mockResolvedValue(undefined);
const scheduler = { addJob } as unknown as never;

function rowsFor(table: string): Record<string, unknown>[] {
  return db.inserts
    .filter((insert) => insert.table === table)
    .flatMap((insert) => (Array.isArray(insert.values) ? insert.values : [insert.values]));
}

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.updateReturns = [];
  db.selectQueue = [];
  db.executeRows = new Map();
  db.executed = [];
  addJob.mockClear();
});

/**
 * A client with one keyword drop and one page-experience problem on the SAME
 * page: the compound case the plane exists to notice.
 */
function seedCompoundCase(): void {
  db.executeRows.set("reporting.keyword_drops_7d", [
    {
      keyword: "roofing austin",
      device: "desktop",
      previous_position: "4",
      current_position: "13",
      position_delta: "9",
      url: "https://client.example/roofing",
      checked_at: "2026-08-30T06:00:00Z",
    },
  ]);
  db.executeRows.set("reporting.page_experience_risks", [
    {
      page_path: "/roofing",
      period: "7d",
      exit_rate: 0.74,
      lcp: 4100,
      total_pageviews: "800",
      risk_level: "critical",
      device: "mobile",
    },
  ]);

  db.selectQueue = [
    [{ id: CLIENT, industry: "roofing", state: "TX", active: true }], // client lookup
    [], // recent fingerprints (nothing suppressed)
    [{ id: "opportunity-row-1", fingerprint: undefined }], // loadOpportunityIds — patched below
    [], // open opportunity fingerprints
  ];
}

describe("runClientTriage — the durable record", () => {
  it("links each decision to the opportunity it acted on", async () => {
    seedCompoundCase();

    // loadOpportunityIds must return the fingerprint the scorer produced, so
    // resolve it the same way the runner does.
    const { buildOpportunities } = await import("../../src/intelligence/opportunity-scorer.js");
    const { keywordDropExtractor, pageExperienceExtractor } = await import(
      "../../src/intelligence/signal-extractor.js"
    );
    const signals = [
      keywordDropExtractor.mapRow(
        {
          keyword: "roofing austin",
          position_delta: "9",
          url: "https://client.example/roofing",
        },
        CLIENT,
      ),
      pageExperienceExtractor.mapRow(
        { page_path: "/roofing", risk_level: "critical", total_pageviews: "800" },
        CLIENT,
      ),
    ].filter((signal) => signal !== null);
    const expected = buildOpportunities(signals).opportunities;
    expect(expected).toHaveLength(1);

    db.selectQueue[2] = [{ id: "opportunity-row-1", fingerprint: expected[0].fingerprint }];

    await runClientTriage(CLIENT, "cron", scheduler);

    const decisions = rowsFor("decisions");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].opportunityId).toBe("opportunity-row-1");
  });

  it("links the experiment to the decision that opened it", async () => {
    seedCompoundCase();
    await runClientTriage(CLIENT, "cron", scheduler);

    const experiments = rowsFor("experiments");
    expect(experiments).toHaveLength(1);
    // The id the decisions insert returned — not null, which is what an
    // unlinked experiment would silently record.
    expect(experiments[0].decisionId).toMatch(/^decisions-id-\d+$/);
  });

  it("links the experiment to the action outcome the memory promoter reads", async () => {
    seedCompoundCase();
    await runClientTriage(CLIENT, "cron", scheduler);

    const experiments = rowsFor("experiments");
    expect(experiments[0].actionOutcomeId).toBeTruthy();
    expect(rowsFor("action_outcomes")).toHaveLength(1);
  });

  it("records the run's counters without duplicating its own identity", async () => {
    seedCompoundCase();
    const summary = await runClientTriage(CLIENT, "cron", scheduler);

    const completion = db.updates.find((update) => update.table === "runs");
    expect(completion).toBeDefined();
    const values = completion?.values as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(values.metadata).not.toHaveProperty("runId");
    expect(values.metadata).not.toHaveProperty("clientId");
    expect(values.metadata.opportunities).toBe(summary.opportunities);
    expect(values.status).toBe("completed");
  });
});

describe("runClientTriage — suppression must expire", () => {
  it("does not suppress an opportunity with no live predecessor", async () => {
    // Suppression is keyed on the LIFECYCLE now (contract C3): only `open` and
    // `actioned` opportunities suppress. Before status transitioned, an
    // unbounded `status = 'open'` lookup matched every opportunity ever
    // recorded and suppression was permanent — a problem acted on once and not
    // actually fixed was re-detected, re-grouped to the same fingerprint, and
    // then silently dropped on every later run. A `resolved` or `expired` row
    // is what now lets a recurring problem come back.
    seedCompoundCase();
    await runClientTriage(CLIENT, "cron", scheduler);

    // The opportunity did NOT get suppressed on this run (nothing prior existed),
    // so it produced a decision that acted rather than one that suppressed.
    const decisions = rowsFor("decisions");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).not.toBe("suppress_duplicate");
  });

  it("suppresses an opportunity whose fingerprint is already live", async () => {
    seedCompoundCase();
    const { buildOpportunities } = await import("../../src/intelligence/opportunity-scorer.js");
    const { keywordDropExtractor, pageExperienceExtractor } = await import(
      "../../src/intelligence/signal-extractor.js"
    );
    const signals = [
      keywordDropExtractor.mapRow(
        { keyword: "roofing austin", position_delta: "9", url: "https://client.example/roofing" },
        CLIENT,
      ),
      pageExperienceExtractor.mapRow(
        { page_path: "/roofing", risk_level: "critical", total_pageviews: "800" },
        CLIENT,
      ),
    ].filter((signal) => signal !== null);
    const fingerprint = buildOpportunities(signals).opportunities[0].fingerprint;

    // A prior run's opportunity, still in a live (open/actioned) status.
    db.selectQueue[3] = [{ fingerprint }];

    await runClientTriage(CLIENT, "cron", scheduler);

    const decisions = rowsFor("decisions");
    expect(decisions[0].decision).toBe("suppress_duplicate");
    expect(addJob).not.toHaveBeenCalled();
  });
});

describe("runClientTriage — the boundary it must not cross", () => {
  it("queues only the allow-listed follow-up job", async () => {
    seedCompoundCase();
    await runClientTriage(CLIENT, "cron", scheduler);

    expect(addJob).toHaveBeenCalledTimes(1);
    const [jobName, payload] = addJob.mock.calls[0];
    expect(jobName).toBe("serp:generate-surpass-plan");
    expect(jobName).not.toBe("serp:execute-surpass-plans");
    expect(payload).toEqual({ clientId: CLIENT });
  });

  it("still records the run when no scheduler is available, and queues nothing", async () => {
    seedCompoundCase();
    const summary = await runClientTriage(CLIENT, "cron");

    expect(summary.jobsQueued).toBe(0);
    expect(addJob).not.toHaveBeenCalled();
    // Reasoning still happened and is still durable.
    expect(summary.opportunities).toBe(1);
    expect(rowsFor("decisions")).toHaveLength(1);
  });

  it("marks the run failed and rethrows when the client does not exist", async () => {
    db.selectQueue = [[]];
    await expect(runClientTriage(CLIENT, "cron", scheduler)).rejects.toThrow(/not found/);

    const completion = db.updates.find((update) => update.table === "runs");
    expect(completion).toBeDefined();
    expect((completion?.values as { status: string } | undefined)?.status).toBe("failed");
  });

  it("spends no tokens to reason: the run is recorded as llmUsed=false", async () => {
    seedCompoundCase();
    await runClientTriage(CLIENT, "cron", scheduler);
    expect(rowsFor("runs")[0].llmUsed).toBe(false);
  });
});

describe("attributionEntity", () => {
  function opportunity(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
    return {
      clientId: CLIENT,
      opportunityType: "answer_engine_gap",
      title: "t",
      description: "d",
      targetUrl: "/pricing",
      targetKeyword: "roofing austin",
      expectedImpact: 6,
      effort: 4,
      risk: 1,
      urgency: 0.75,
      confidence: 0.8,
      score: 40,
      fingerprint: "fp",
      signals: [],
      evidence: {},
      ...overrides,
    };
  }

  it("measures a ranking change against the keyword", () => {
    expect(attributionEntity("serp_position", opportunity())).toBe("roofing austin");
  });

  it("measures an engagement change against the page", () => {
    expect(attributionEntity("page_exit_rate", opportunity())).toBe("/pricing");
  });

  it("measures a citation change against the platform named on the signal", () => {
    const withPlatform = opportunity({
      signals: [
        {
          clientId: CLIENT,
          entityType: "platform",
          entityId: "perplexity",
          signalType: "citation_rate_down",
          severity: "high",
          confidence: 0.8,
          evidence: { platform: "perplexity" },
          fingerprint: "f",
          groupKey: "platform:perplexity",
        },
      ],
    });
    expect(attributionEntity("aeo_citation_rate", withPlatform)).toBe("perplexity");
  });

  it("returns null rather than measuring against a target it does not have", () => {
    // No entity means no window opens — better than measuring the wrong thing
    // and recording the result as a learning.
    expect(attributionEntity("serp_position", opportunity({ targetKeyword: null }))).toBeNull();
    expect(attributionEntity("page_exit_rate", opportunity({ targetUrl: null }))).toBeNull();
    expect(attributionEntity("aeo_citation_rate", opportunity())).toBeNull();
  });
});
