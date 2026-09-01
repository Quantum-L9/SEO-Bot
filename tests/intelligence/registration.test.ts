/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * Registration is where a continuously-reasoning bot could quietly become a
 * continuously-billing one. Every job this plane adds must declare a ZERO token
 * budget: extraction, grouping, scoring and the policy gate are deterministic,
 * and tokens are spent later by the module jobs it queues, under those jobs'
 * own budgets.
 *
 * The handlers are also exercised for their failure behavior — in particular
 * that a failed materialized refresh THROWS, so it lands in job_executions and
 * the job_failure_cluster extractor can see it. A refresh that fails silently
 * leaves the portfolio views serving a stale snapshot indefinitely.
 */

import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rollout = vi.hoisted(() => ({
  mode: "full" as string,
  llmPlanningEnabled: true,
}));

const hooks = vi.hoisted(() => ({
  refreshOutcomes: [] as { viewName: string; status: string; durationMs: number }[],
  measured: [] as { experimentId: string; verdict: string }[],
  triageCalls: [] as unknown[],
  policyRefreshCount: 0,
  approvedPickups: [] as unknown[],
  expiredCount: 0,
  lifecycleConfigChecked: [] as unknown[],
  portfolioRuns: 0,
  synthesisLimits: [] as number[],
  synthesisOutcomes: [] as { actionLogId: string; clientId: string; optionCount: number }[],
}));

vi.mock("../../src/reporting/refresh.js", () => ({
  refreshMaterializedViews: async () => hooks.refreshOutcomes,
}));
vi.mock("../../src/intelligence/outcome-attributor.js", () => ({
  measureDueExperiments: async () => hooks.measured,
}));
vi.mock("../../src/intelligence/plan-synthesizer.js", () => ({
  synthesizePendingProposals: async (limit: number) => {
    hooks.synthesisLimits.push(limit);
    return hooks.synthesisOutcomes;
  },
}));
vi.mock("../../src/intelligence/portfolio.js", () => ({
  runPortfolioBenchmark: async () => {
    hooks.portfolioRuns += 1;
    return {
      runId: "run-1",
      publishedCohorts: 0,
      suppressedCohorts: 3,
      periods: 0,
      anonymityFloor: 5,
    };
  },
}));
vi.mock("../../src/intelligence/runner.js", () => ({
  runClientTriage: async (...args: unknown[]) => {
    hooks.triageCalls.push(args);
    return {};
  },
  refreshAllPolicyState: async () => {
    hooks.policyRefreshCount += 1;
    return 3;
  },
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
// Registration asserts the lifecycle config invariant (expiry must outlast the
// signal cooldown), which reaches the real loader — and the real loader calls
// process.exit on an unpopulated environment. Registration is what is under
// test here, not env parsing, so the two values are stubbed like every other
// dependency in this suite.
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: 30,
    INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: 7,
    INTELLIGENCE_SYNTHESIS_BATCH_SIZE: 10,
    // `full` + planning on, so the budget and cron assertions below see every
    // definition. The rollout-gate suite at the bottom varies these deliberately.
    INTELLIGENCE_MODE: rollout.mode,
    INTELLIGENCE_LLM_PLANNING_ENABLED: rollout.llmPlanningEnabled,
    INTELLIGENCE_ALLOW_OUTREACH_ROUTING: false,
    INTELLIGENCE_ALLOW_SITE_MUTATION: false,
  }),
}));
vi.mock("../../src/intelligence/lifecycle.js", () => ({
  assertLifecycleConfig: (config: {
    INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: number;
    INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: number;
  }) => {
    hooks.lifecycleConfigChecked.push(config);
  },
  sweepApprovedActions: async () => hooks.approvedPickups,
  expireStaleOpportunities: async () => hooks.expiredCount,
}));

import { INTELLIGENCE_JOBS, registerIntelligenceHandlers } from "../../src/intelligence/index.js";
import type { JobDefinition } from "../../src/types/index.js";

interface FakeScheduler {
  definitions: JobDefinition[];
  handlers: Map<string, (job: Job) => Promise<void>>;
  registerDefinition: (definition: JobDefinition) => void;
  registerHandler: (name: string, handler: (job: Job) => Promise<void>) => void;
}

function fakeScheduler(): FakeScheduler {
  const scheduler: FakeScheduler = {
    definitions: [],
    handlers: new Map(),
    registerDefinition: (definition) => {
      scheduler.definitions.push(definition);
    },
    registerHandler: (name, handler) => {
      scheduler.handlers.set(name, handler);
    },
  };
  return scheduler;
}

let scheduler: FakeScheduler;

beforeEach(() => {
  hooks.refreshOutcomes = [];
  hooks.measured = [];
  hooks.triageCalls = [];
  hooks.policyRefreshCount = 0;
  hooks.approvedPickups = [];
  hooks.expiredCount = 0;
  hooks.lifecycleConfigChecked = [];
  hooks.portfolioRuns = 0;
  hooks.synthesisLimits = [];
  hooks.synthesisOutcomes = [];
  rollout.mode = "full";
  rollout.llmPlanningEnabled = true;
  scheduler = fakeScheduler();
  registerIntelligenceHandlers(scheduler as unknown as never);
});

describe("job definitions", () => {
  it("registers a handler for every definition it declares", () => {
    const declared = scheduler.definitions.map((definition) => definition.name).sort();
    const handled = [...scheduler.handlers.keys()].sort();
    expect(declared).toEqual(handled);
    expect(declared).toEqual([...Object.values(INTELLIGENCE_JOBS)].sort());
  });

  it("declares a zero token budget on every job but the one that is allowed to spend", () => {
    // Reasoning is deterministic. A non-zero budget on a REASONING job would
    // mean the plane started spending on every client, every day, forever.
    //
    // Plan synthesis (contract C2) genuinely spends, so the invariant is pinned
    // as a named list of one rather than relaxed to "most jobs": a second
    // budgeted job then has to be added HERE to pass, which is the point.
    const BUDGETED: readonly string[] = [INTELLIGENCE_JOBS.planSynthesis];

    for (const definition of scheduler.definitions) {
      if (BUDGETED.includes(definition.name)) continue;
      expect(definition.tokenBudget, definition.name).toEqual({
        maxFastTokensPerRun: 0,
        maxStrategicTokensPerRun: 0,
        cooldownMinutes: 0,
      });
    }
  });

  it("bounds the one budgeted job rather than leaving it open-ended", () => {
    const synthesis = scheduler.definitions.find(
      (definition) => definition.name === INTELLIGENCE_JOBS.planSynthesis,
    );
    expect(synthesis?.tokenBudget.maxStrategicTokensPerRun).toBeGreaterThan(0);
    // A cooldown is what stops a retried or manually-triggered job from
    // reaching a model back-to-back.
    expect(synthesis?.tokenBudget.cooldownMinutes).toBeGreaterThan(0);
  });

  it("synthesizes after triage has produced the day's proposals", () => {
    // Before it, the sweep would rank yesterday's leftovers and today's
    // proposals would wait a full day for their options.
    const byName = new Map(scheduler.definitions.map((d) => [d.name, d]));
    const hourOf = (name: string) => Number(byName.get(name)?.cron.split(" ")[1]);
    expect(hourOf(INTELLIGENCE_JOBS.planSynthesis)).toBeGreaterThan(
      hourOf(INTELLIGENCE_JOBS.dailyTriage),
    );
  });

  it("scopes triage per client and leaves the sweeps global", () => {
    const byName = new Map(scheduler.definitions.map((d) => [d.name, d]));
    expect(byName.get(INTELLIGENCE_JOBS.dailyTriage)?.clientScoped).toBe(true);
    expect(byName.get(INTELLIGENCE_JOBS.outcomeAttribution)?.clientScoped).toBe(false);
    expect(byName.get(INTELLIGENCE_JOBS.policyRefresh)?.clientScoped).toBe(false);
    expect(byName.get(INTELLIGENCE_JOBS.lifecycleSweep)?.clientScoped).toBe(false);
    // The portfolio run is the one run type with no client at all: fanning it
    // out per client would produce N identical cross-client snapshots.
    expect(byName.get(INTELLIGENCE_JOBS.portfolioBenchmark)?.clientScoped).toBe(false);
    expect(byName.get(INTELLIGENCE_JOBS.reportingRefresh)?.clientScoped).toBe(false);
  });

  it("runs the lifecycle sweep hourly, not once a day", () => {
    // An operator who approves a CRITICAL action at 09:00 should not wait for
    // the overnight pass before its follow-up job is queued.
    const sweep = scheduler.definitions.find((d) => d.name === INTELLIGENCE_JOBS.lifecycleSweep);
    expect(sweep?.cron.split(" ")[1]).toBe("*");
  });

  it("proves the expiry window outlasts the signal cooldown at registration", () => {
    // The two are set independently by environment. Crossing them makes routine
    // signal suppression look like the problem going away, and live
    // opportunities expire — with nothing failing to say so.
    expect(hooks.lifecycleConfigChecked).toHaveLength(1);
  });

  it("runs triage after the overnight collection jobs, not before them", () => {
    // SERP checks at 06:00 and engagement at 05:00; reasoning over yesterday's
    // facts would silently make every signal a day stale.
    const triage = scheduler.definitions.find((d) => d.name === INTELLIGENCE_JOBS.dailyTriage);
    const [minute, hour] = (triage?.cron ?? "").split(" ");
    expect(Number(hour)).toBeGreaterThan(6);
    expect(Number.isNaN(Number(minute))).toBe(false);
  });

  it("gives every definition a valid five-field cron expression", () => {
    for (const definition of scheduler.definitions) {
      expect(definition.cron.split(" "), definition.name).toHaveLength(5);
    }
  });
});

describe("handlers", () => {
  it("runs triage for the fanned-out client", async () => {
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.dailyTriage);
    await handler?.({ id: "1", data: { clientId: "client-1" } } as unknown as Job);
    expect(hooks.triageCalls).toHaveLength(1);
    expect((hooks.triageCalls[0] as unknown[])[0]).toBe("client-1");
  });

  it("skips — rather than throwing — a client-scoped job that arrived without a client", async () => {
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.dailyTriage);
    await expect(handler?.({ id: "1", data: {} } as unknown as Job)).resolves.toBeUndefined();
    expect(hooks.triageCalls).toHaveLength(0);
  });

  it("throws when a materialized refresh fails, so the failure is recorded", async () => {
    // job_executions is what the job_failure_cluster extractor reads; swallowing
    // this would leave the portfolio views stale with nothing to notice it.
    hooks.refreshOutcomes = [
      { viewName: "reporting.mv_llm_spend_monthly", status: "error", durationMs: 5 },
    ];
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.reportingRefresh);
    await expect(handler?.({} as Job)).rejects.toThrow(/mv_llm_spend_monthly/);
  });

  it("succeeds quietly when every refresh worked", async () => {
    hooks.refreshOutcomes = [
      { viewName: "reporting.mv_llm_spend_monthly", status: "ok", durationMs: 5 },
    ];
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.reportingRefresh);
    await expect(handler?.({} as Job)).resolves.toBeUndefined();
  });

  it("runs the lifecycle sweep: approved pickups and expiry together", async () => {
    hooks.approvedPickups = [{ actionLogId: "a1" }];
    hooks.expiredCount = 2;
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.lifecycleSweep);
    await expect(handler?.({} as Job)).resolves.toBeUndefined();
  });

  it("passes the configured batch size to the synthesis sweep", async () => {
    // The sweep is the plane's only token-spending step; an unbounded one after
    // an unusual day is where a deterministic system produces a surprising bill.
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.planSynthesis);
    await expect(handler?.({} as Job)).resolves.toBeUndefined();
    expect(hooks.synthesisLimits).toEqual([10]);
  });

  it("records a portfolio benchmark run", async () => {
    const handler = scheduler.handlers.get(INTELLIGENCE_JOBS.portfolioBenchmark);
    await expect(handler?.({} as Job)).resolves.toBeUndefined();
    expect(hooks.portfolioRuns).toBe(1);
  });

  it("runs the attribution and policy sweeps", async () => {
    hooks.measured = [{ experimentId: "e1", verdict: "improved" }];
    await scheduler.handlers.get(INTELLIGENCE_JOBS.outcomeAttribution)?.({} as Job);
    await scheduler.handlers.get(INTELLIGENCE_JOBS.policyRefresh)?.({} as Job);
    expect(hooks.policyRefreshCount).toBe(1);
  });
});

// ─── The rollout gate at registration (hardening contract C5) ────────────────

describe("registration honours the rollout mode", () => {
  /** Re-register against a fresh scheduler at the given rung. */
  function registerAt(mode: string, llmPlanningEnabled = true): FakeScheduler {
    rollout.mode = mode;
    rollout.llmPlanningEnabled = llmPlanningEnabled;
    const fresh = fakeScheduler();
    registerIntelligenceHandlers(fresh as unknown as never);
    return fresh;
  }

  function enabledNames(s: FakeScheduler): string[] {
    return s.definitions.filter((d) => d.enabled).map((d) => d.name);
  }

  it("enables no intelligence job in off mode", () => {
    // Registered-but-disabled, not absent: the scheduler skips creating the
    // queue and the repeatable cron, so the job cannot fire and then decline.
    const s = registerAt("off");
    const intelligenceJobs = enabledNames(s).filter((n) => n.startsWith("intel:"));
    expect(intelligenceJobs).toEqual([]);
  });

  it("keeps the reporting refresh enabled even in off mode", () => {
    // The reporting plane stands on its own and serves the operator dashboard.
    // Gating it on the intelligence mode would silently stale every report in
    // the product the moment someone turned the bot's reasoning off.
    const s = registerAt("off");
    expect(enabledNames(s)).toContain(INTELLIGENCE_JOBS.reportingRefresh);
  });

  it("enables triage but not the lifecycle sweep in observe mode", () => {
    const s = registerAt("observe");
    const names = enabledNames(s);
    expect(names).toContain(INTELLIGENCE_JOBS.dailyTriage);
    // Nothing can be approved when nothing is proposed, so a sweep here would
    // be a job that can only ever find zero rows.
    expect(names).not.toContain(INTELLIGENCE_JOBS.lifecycleSweep);
  });

  it("never enables the one budgeted job below route_llm", () => {
    // The token-spending job is the one whose accidental enablement costs money,
    // so it is asserted against EVERY rung below its own rather than spot-checked.
    for (const mode of ["off", "observe", "recommend", "route_safe"]) {
      const s = registerAt(mode);
      expect(enabledNames(s), `${mode} enabled the budgeted synthesis job`).not.toContain(
        INTELLIGENCE_JOBS.planSynthesis,
      );
    }
  });

  it("enables the budgeted job at route_llm only when the flag is also set", () => {
    expect(enabledNames(registerAt("route_llm", false))).not.toContain(
      INTELLIGENCE_JOBS.planSynthesis,
    );
    expect(enabledNames(registerAt("route_llm", true))).toContain(INTELLIGENCE_JOBS.planSynthesis);
  });

  it("registers every definition at every rung, disabling rather than omitting", () => {
    // A job that vanishes from the definition list cannot be inspected, and
    // `status` would stop reporting it. Disabled is visible; absent is not.
    const atFull = registerAt("full").definitions.length;
    for (const mode of ["off", "observe", "recommend", "route_safe", "route_llm"]) {
      expect(registerAt(mode).definitions.length, `${mode} omitted a definition`).toBe(atFull);
    }
  });
});
