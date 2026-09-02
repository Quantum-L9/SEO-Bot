/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Testing contract §11 — the staged cutover, Stage A through Stage E.
 *
 * `mode.test.ts` proves the ladder's PREDICATES are monotonic, and
 * `runner.test.ts` spot-checks three rungs against the runner. Neither answers
 * the question an operator actually has on cutover night, which is not "is
 * `route` true at `route_safe`?" but "if I set these five variables and restart,
 * what exactly will the bot do tonight, and what will it not do?"
 *
 * So this file asserts the WHOLE side-effect ledger at each rung rather than one
 * property of it — every table written, every job queued, every action_log
 * status — from one shared seed, so the stages are directly comparable and a
 * capability that leaks into a lower rung shows up as a diff rather than as a
 * missing assertion nobody wrote.
 *
 * The seed carries two opportunities on purpose: one whose remedy is a safe
 * analysis job, and one whose remedy is outreach. A single-opportunity fixture
 * cannot tell "this rung routes" from "this rung routes EVERYTHING", which is
 * the distinction Stage C exists to make.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

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
  selectQueue: [] as unknown[],
  executeRows: new Map<string, Record<string, unknown>[]>(),
}));

vi.mock("../../src/core/database/index.js", () => {
  const dialect = new PgDialect();
  const thenable = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const method of ["from", "where", "orderBy", "limit"]) p[method] = () => p;
    return p;
  };
  const instance = {
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
          const rows = [{ id: `${table.__table}-updated` }];
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
      for (const [needle, rows] of db.executeRows) {
        if (sql.includes(needle)) return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { getDb: () => instance, schema: tables };
});

/** The five variables an operator actually turns. */
const rollout = vi.hoisted(() => ({
  mode: "off" as string,
  llmPlanningEnabled: false,
  allowOutreachRouting: false,
  allowSiteMutation: false,
}));

vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    DEFAULT_CLIENT_MONTHLY_BUDGET: 200,
    DAILY_SPEND_CAP: 10,
    INTELLIGENCE_MIN_OPPORTUNITY_SCORE: 20,
    INTELLIGENCE_MAX_ACTIONS_PER_RUN: 3,
    INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
    INTELLIGENCE_BASELINE_DAYS: 14,
    INTELLIGENCE_MEASUREMENT_DAYS: 28,
    INTELLIGENCE_MODE: rollout.mode,
    INTELLIGENCE_LLM_PLANNING_ENABLED: rollout.llmPlanningEnabled,
    INTELLIGENCE_ALLOW_OUTREACH_ROUTING: rollout.allowOutreachRouting,
    INTELLIGENCE_ALLOW_SITE_MUTATION: rollout.allowSiteMutation,
  }),
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { runClientTriage } from "../../src/intelligence/runner.js";

const addJob = vi.fn().mockResolvedValue(undefined);
const scheduler = { addJob } as unknown as never;

/**
 * One seed, used at every rung. Produces two opportunities:
 *
 *   - a keyword drop and a page-experience problem on the SAME page, which the
 *     scorer merges into the compound diagnosis whose remedy is a safe
 *     analysis job (`serp:generate-surpass-plan`);
 *   - a batch of contactable high-authority prospects, whose remedy is
 *     outreach (`links:process-outreach`) — mail to third parties.
 */
function seed(): void {
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
  db.executeRows.set("FROM link_prospects", [
    {
      prospect_count: "45",
      best_domain_rating: "78",
      avg_domain_rating: "56.4",
      // Contactable, and enough of them to clear the action threshold. A batch
      // nobody can write to is not an outreach opportunity at any size, so the
      // fixture has to be reachable or the outreach stages below would pass for
      // want of a candidate rather than because the gate held.
      with_contact: "31",
    },
  ]);

  db.selectQueue = [
    [{ id: CLIENT, industry: "roofing", state: "TX", active: true }],
    [], // nothing suppressed
    [], // opportunity ids (the links are asserted in runner.test.ts, not here)
    [], // no open fingerprints
  ];
}

interface Ledger {
  runs: number;
  signals: number;
  opportunities: number;
  decisions: number;
  actionLogStatuses: string[];
  outcomes: number;
  experiments: number;
  jobs: string[];
  llmUsed: boolean;
}

function rowsFor(table: string): Record<string, unknown>[] {
  return db.inserts
    .filter((insert) => insert.table === table)
    .flatMap((insert) => (Array.isArray(insert.values) ? insert.values : [insert.values]));
}

/** Run one rung and return everything it touched. */
async function runStage(settings: Partial<typeof rollout>): Promise<Ledger> {
  Object.assign(rollout, settings);
  seed();
  const summary = await runClientTriage(CLIENT, "cron", scheduler);
  return {
    runs: rowsFor("runs").length,
    signals: rowsFor("signals").length,
    opportunities: rowsFor("opportunities").length,
    decisions: rowsFor("decisions").length,
    actionLogStatuses: rowsFor("action_log").map((row) => String(row.status)),
    outcomes: rowsFor("action_outcomes").length,
    experiments: rowsFor("experiments").length,
    jobs: addJob.mock.calls.map((call) => String(call[0])),
    llmUsed: Boolean((summary as unknown as { llmUsed?: boolean }).llmUsed),
  };
}

const SAFE_JOB = "serp:generate-surpass-plan";
const OUTREACH_JOB = "links:process-outreach";
/** Excluded from TRIGGERABLE_JOBS entirely — no rung may reach it. */
const LIVE_WRITE_JOB = "serp:execute-surpass-plans";

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.selectQueue = [];
  db.executeRows = new Map();
  addJob.mockClear();
  rollout.mode = "off";
  rollout.llmPlanningEnabled = false;
  rollout.allowOutreachRouting = false;
  rollout.allowSiteMutation = false;
});

describe("the seed produces the two opportunities the stages are compared on", () => {
  it("diagnoses a compound page problem and a contactable prospect batch", async () => {
    const ledger = await runStage({ mode: "recommend" });
    // Guards every stage below: if the seed stopped producing both, the
    // "queues only the safe job" assertions would pass for want of an outreach
    // opportunity rather than because outreach was withheld.
    expect(ledger.opportunities).toBe(2);
    expect(ledger.decisions).toBe(2);
  });
});

describe("Stage A — observe", () => {
  it("records what it saw and proposes nothing at all", async () => {
    const ledger = await runStage({ mode: "observe" });

    // Diagnosis runs in full: this is the point of the rung.
    expect(ledger.runs).toBe(1);
    expect(ledger.signals).toBeGreaterThan(0);
    expect(ledger.opportunities).toBe(2);

    // And nothing else happens. action_log is the operator's record of what the
    // bot DID; an observe-mode run must leave no trace in it at all — not a
    // pending row, not a withheld one.
    expect(ledger.decisions).toBe(0);
    expect(ledger.actionLogStatuses).toEqual([]);
    expect(ledger.outcomes).toBe(0);
    expect(ledger.experiments).toBe(0);
    expect(ledger.jobs).toEqual([]);
  });

  it("spends nothing to reason", async () => {
    const ledger = await runStage({ mode: "observe" });
    expect(ledger.llmUsed).toBe(false);
  });
});

describe("Stage B — recommend", () => {
  it("writes the decision and the proposal, and queues nothing", async () => {
    const ledger = await runStage({ mode: "recommend" });

    expect(ledger.decisions).toBe(2);
    expect(ledger.actionLogStatuses.length).toBeGreaterThan(0);
    expect(ledger.jobs).toEqual([]);
  });

  it("records every withheld proposal as awaiting approval, never as executed", async () => {
    const ledger = await runStage({ mode: "recommend" });
    // The gate runs BEFORE logAction. Were the order reversed, a withheld
    // action would be indistinguishable in action_log from a performed one.
    expect(ledger.actionLogStatuses.every((status) => status === "pending_approval")).toBe(true);
    expect(ledger.actionLogStatuses).not.toContain("auto_executed");
  });

  it("opens no measurement window for work that did not happen", async () => {
    const ledger = await runStage({ mode: "recommend" });
    // Measuring from a moment nothing happened attributes the world's noise to
    // the bot, and then reports it as a result.
    expect(ledger.outcomes).toBe(0);
    expect(ledger.experiments).toBe(0);
  });
});

describe("Stage C — route_safe", () => {
  it("queues the safe analysis job and opens its measurement window", async () => {
    const ledger = await runStage({ mode: "route_safe" });

    expect(ledger.jobs).toContain(SAFE_JOB);
    expect(ledger.outcomes).toBeGreaterThan(0);
    expect(ledger.experiments).toBeGreaterThan(0);
  });

  it("sends no mail — the rung's one explicit promise", async () => {
    const ledger = await runStage({ mode: "route_safe" });
    expect(ledger.jobs).not.toContain(OUTREACH_JOB);
  });

  it("records the withheld outreach as awaiting approval rather than dropping it", async () => {
    const ledger = await runStage({ mode: "route_safe" });
    // Withheld is not the same as wrong: the bot still believes the action is
    // right, and an operator can approve it by hand. Both statuses present is
    // exactly the mixed state this rung is supposed to produce.
    expect(ledger.actionLogStatuses).toContain("auto_executed");
    expect(ledger.actionLogStatuses).toContain("pending_approval");
  });

  it("writes to a client's live site through no path", async () => {
    const ledger = await runStage({ mode: "route_safe" });
    expect(ledger.jobs).not.toContain(LIVE_WRITE_JOB);
  });
});

describe("Stage D — route_llm", () => {
  it("changes what may be RANKED, not what may be queued", async () => {
    const safe = await runStage({ mode: "route_safe" });
    db.inserts = [];
    addJob.mockClear();
    const llm = await runStage({ mode: "route_llm", llmPlanningEnabled: true });

    // Ranking happens in `intel:synthesize-plans`, a separate budgeted job over
    // proposals already awaiting approval. Raising the rung must not widen the
    // set of jobs triage itself queues.
    expect(llm.jobs.sort()).toEqual(safe.jobs.sort());
    expect(llm.jobs).not.toContain(OUTREACH_JOB);
  });

  it("still spends no tokens in triage itself", async () => {
    const ledger = await runStage({ mode: "route_llm", llmPlanningEnabled: true });
    // The zero-token invariant on the reasoning path holds at every rung; only
    // the synthesis job is allowed a budget (registration.test.ts pins that).
    expect(ledger.llmUsed).toBe(false);
  });
});

describe("Stage E — full, dry-run", () => {
  it("still refuses outreach until the outreach flag is set", async () => {
    const ledger = await runStage({ mode: "full", llmPlanningEnabled: true });
    // `full` is the top of the ladder and grants neither irreversible
    // capability. An operator raising the mode for better ranking must not
    // thereby acquire the right to email a stranger.
    expect(ledger.jobs).not.toContain(OUTREACH_JOB);
  });

  it("queues outreach once the ladder AND the flag are both set", async () => {
    const ledger = await runStage({
      mode: "full",
      llmPlanningEnabled: true,
      allowOutreachRouting: true,
    });
    expect(ledger.jobs).toContain(OUTREACH_JOB);
    expect(ledger.jobs).toContain(SAFE_JOB);
  });

  it("reaches the live-site write job through no combination of flags", async () => {
    const ledger = await runStage({
      mode: "full",
      llmPlanningEnabled: true,
      allowOutreachRouting: true,
      allowSiteMutation: true,
    });
    // Both out-of-ladder flags on, at the top of the ladder. The live-write job
    // is still unreachable, because it is excluded from TRIGGERABLE_JOBS and no
    // plan template names it — two locks, neither of which is a rollout flag.
    expect(ledger.jobs).not.toContain(LIVE_WRITE_JOB);
    expect(ledger.jobs.every((job) => job !== LIVE_WRITE_JOB)).toBe(true);
  });
});

describe("the ladder as a whole", () => {
  it("never withdraws a side effect that a lower rung produced", async () => {
    // Monotonicity where it is actually observable. `mode.test.ts` asserts this
    // over the predicates; here it is asserted over what the runner DID, which
    // is what an operator raising a rung is promised.
    const ledgers: Ledger[] = [];
    for (const mode of ["observe", "recommend", "route_safe", "route_llm", "full"]) {
      db.inserts = [];
      addJob.mockClear();
      ledgers.push(await runStage({ mode, llmPlanningEnabled: mode !== "observe" }));
    }

    for (let i = 1; i < ledgers.length; i += 1) {
      const lower = ledgers[i - 1];
      const higher = ledgers[i];
      expect(higher.runs, `runs at rung ${i}`).toBeGreaterThanOrEqual(lower.runs);
      expect(higher.opportunities, `opportunities at rung ${i}`).toBeGreaterThanOrEqual(
        lower.opportunities,
      );
      expect(higher.decisions, `decisions at rung ${i}`).toBeGreaterThanOrEqual(lower.decisions);
      expect(higher.jobs.length, `jobs at rung ${i}`).toBeGreaterThanOrEqual(lower.jobs.length);
    }
  });

  it("does nothing whatsoever in off mode", async () => {
    const ledger = await runStage({ mode: "off" });
    expect(ledger).toMatchObject({
      decisions: 0,
      opportunities: 0,
      outcomes: 0,
      experiments: 0,
      actionLogStatuses: [],
      jobs: [],
    });
  });
});
