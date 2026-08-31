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

const hooks = vi.hoisted(() => ({
  refreshOutcomes: [] as { viewName: string; status: string; durationMs: number }[],
  measured: [] as { experimentId: string; verdict: string }[],
  triageCalls: [] as unknown[],
  policyRefreshCount: 0,
  approvedPickups: [] as unknown[],
  expiredCount: 0,
  lifecycleConfigChecked: [] as unknown[],
}));

vi.mock("../../src/reporting/refresh.js", () => ({
  refreshMaterializedViews: async () => hooks.refreshOutcomes,
}));
vi.mock("../../src/intelligence/outcome-attributor.js", () => ({
  measureDueExperiments: async () => hooks.measured,
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

  it("declares a zero token budget on every job", () => {
    // Reasoning is deterministic. A non-zero budget here would mean the plane
    // itself started spending on every client, every day, forever.
    for (const definition of scheduler.definitions) {
      expect(definition.tokenBudget, definition.name).toEqual({
        maxFastTokensPerRun: 0,
        maxStrategicTokensPerRun: 0,
        cooldownMinutes: 0,
      });
    }
  });

  it("scopes triage per client and leaves the sweeps global", () => {
    const byName = new Map(scheduler.definitions.map((d) => [d.name, d]));
    expect(byName.get(INTELLIGENCE_JOBS.dailyTriage)?.clientScoped).toBe(true);
    expect(byName.get(INTELLIGENCE_JOBS.outcomeAttribution)?.clientScoped).toBe(false);
    expect(byName.get(INTELLIGENCE_JOBS.policyRefresh)?.clientScoped).toBe(false);
    expect(byName.get(INTELLIGENCE_JOBS.lifecycleSweep)?.clientScoped).toBe(false);
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

  it("runs the attribution and policy sweeps", async () => {
    hooks.measured = [{ experimentId: "e1", verdict: "improved" }];
    await scheduler.handlers.get(INTELLIGENCE_JOBS.outcomeAttribution)?.({} as Job);
    await scheduler.handlers.get(INTELLIGENCE_JOBS.policyRefresh)?.({} as Job);
    expect(hooks.policyRefreshCount).toBe(1);
  });
});
