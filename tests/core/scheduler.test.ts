import { beforeEach, describe, expect, it, vi } from "vitest";

// scheduler.ts creates a module logger at import (→ getConfig) and imports
// bullmq/ioredis. The pure id-helper test needs only inert stubs; the class-level
// tests (GAP-006) need CAPTURING stubs that record queue.add / Worker options /
// lifecycle so real scheduling + fan-out + shutdown behavior can be asserted.
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ REDIS_URL: "redis://localhost:6379", BOT_TIMEZONE: "UTC" }),
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Capturing BullMQ / ioredis doubles.
const bull = vi.hoisted(() => ({
  queueAdds: [] as Array<{ queueName: string; name: string; data: any; opts: any }>,
  workers: [] as Array<{ queueName: string; opts: any }>,
  processors: new Map<string, (job: any) => Promise<void>>(),
  closed: { queues: 0, workers: 0, redisQuit: 0 },
}));
vi.mock("bullmq", () => {
  class Queue {
    constructor(
      public name: string,
      _opts?: unknown,
    ) {}
    async add(name: string, data: any, opts: any) {
      bull.queueAdds.push({ queueName: this.name, name, data, opts });
    }
    async close() {
      bull.closed.queues++;
    }
  }
  class Worker {
    constructor(queueName: string, processor: (job: any) => Promise<void>, opts: any) {
      bull.workers.push({ queueName, opts });
      bull.processors.set(queueName, processor);
    }
    on() {
      /* record nothing — events not under test */
    }
    async close() {
      bull.closed.workers++;
    }
  }
  return { Queue, Worker, Job: class {} };
});
vi.mock("ioredis", () => ({
  Redis: class {
    constructor(_url?: unknown, _opts?: unknown) {}
    async quit() {
      bull.closed.redisQuit++;
    }
  },
}));

// DB double for processJob: job-execution insert, active-client select, status update.
const dbState = vi.hoisted(() => ({ activeClients: [] as any[], updateSets: [] as any[] }));
vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "exec-1" }]) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve(dbState.activeClients) }) }),
    update: () => ({
      set: (payload: any) => {
        dbState.updateSets.push(payload);
        return { where: () => Promise.resolve([]) };
      },
    }),
  }),
  schema: { jobExecutions: { id: "je.id" }, clients: { active: "clients.active" } },
}));

import {
  fanoutChildJobId,
  getScheduler,
  isJobEnabled,
  jobDefinitions,
  Scheduler,
} from "../../src/core/scheduler.js";

beforeEach(() => {
  bull.queueAdds.length = 0;
  bull.workers.length = 0;
  bull.processors.clear();
  bull.closed.queues = 0;
  bull.closed.workers = 0;
  bull.closed.redisQuit = 0;
  dbState.activeClients = [];
  dbState.updateSets = [];
});

describe("fanoutChildJobId", () => {
  it("is stable for the same parent job id + client (retry dedup)", () => {
    // Same parent instance id (a retry of the same fire) → same child id, so
    // BullMQ ignores the re-add and the child is not run twice.
    expect(fanoutChildJobId("repeat:vitals:1750000000000", "client-1")).toBe(
      "child:repeat:vitals:1750000000000:client-1",
    );
    expect(fanoutChildJobId("repeat:vitals:1750000000000", "client-1")).toBe(
      "child:repeat:vitals:1750000000000:client-1",
    );
  });

  it("differs across scheduled occurrences so every fire still runs", () => {
    // Every-6-hours job → distinct parent ids per fire → distinct child ids,
    // so later runs the same day are NOT wrongly deduped.
    expect(fanoutChildJobId("repeat:vitals:1750000000000", "c1")).not.toBe(
      fanoutChildJobId("repeat:vitals:1750021600000", "c1"),
    );
  });

  it("differs by client", () => {
    expect(fanoutChildJobId("p1", "a")).not.toBe(fanoutChildJobId("p1", "b"));
  });
});

// ── GAP-006: prove scheduling/fan-out/lifecycle, not just the id helper ────────
describe("Scheduler.start — schedules only enabled jobs on their cron (GAP-006)", () => {
  it("creates a repeat job for every enabled definition and skips disabled ones", async () => {
    await new Scheduler().start();

    const repeatAdds = bull.queueAdds.filter((a) => a.opts?.repeat);
    // `isJobEnabled` — not the raw `enabled` flag — is the predicate the
    // scheduler actually uses. The intelligence module's jobs carry
    // `enabled: true` but are additionally gated on INTELLIGENCE_ENABLED, so
    // asserting against the flag alone would now over-count.
    const schedulable = jobDefinitions.filter(isJobEnabled);
    expect(repeatAdds.length).toBe(schedulable.length);

    // The disabled site-mutating job must NOT be scheduled.
    expect(repeatAdds.some((a) => a.name === "serp:execute-surpass-plans")).toBe(false);

    // Nor may any intelligence job be, while the module is off in config.
    expect(repeatAdds.some((a) => a.name.startsWith("intelligence:"))).toBe(false);

    // Each enabled job carries its authored cron pattern.
    const vitals = repeatAdds.find((a) => a.name === "vitals:check-all-sources");
    expect(vitals?.opts.repeat.pattern).toBe("0 */6 * * *");
  });

  it("starts each worker with concurrency 2 and a 5-per-minute limiter", async () => {
    await new Scheduler().start();
    expect(bull.workers.length).toBeGreaterThan(0);
    for (const w of bull.workers) {
      expect(w.opts.concurrency).toBe(2);
      expect(w.opts.limiter).toEqual({ max: 5, duration: 60000 });
    }
  });
});

describe("Scheduler.processJob — client fan-out (GAP-006)", () => {
  it("enqueues one deterministic-id child per active client, threading clientConfig", async () => {
    dbState.activeClients = [
      { id: "client-a", domain: "a.com", config: { tenant: "A" } },
      { id: "client-b", domain: "b.com", config: { tenant: "B" } },
    ];
    const scheduler = new Scheduler();
    await scheduler.start();
    // A handler must be registered or processJob short-circuits before fan-out.
    scheduler.registerHandler("vitals:check-all-sources", vi.fn());

    bull.queueAdds.length = 0; // drop the repeat-schedule adds; keep only fan-out
    const def = jobDefinitions.find((j) => j.name === "vitals:check-all-sources");
    const processor = bull.processors.get("l9-web-vitals")!;
    await processor({ id: "parent-99", name: def!.name, data: { definition: def } });

    const children = bull.queueAdds.filter((a) => a.opts?.jobId);
    expect(children.length).toBe(2);
    // Deterministic child ids (idempotent on parent retry → no duplicate outreach).
    expect(children.map((c) => c.opts.jobId).sort()).toEqual([
      "child:parent-99:client-a",
      "child:parent-99:client-b",
    ]);
    // Each child carries THAT tenant's id, domain, and config.
    const a = children.find((c) => c.opts.jobId.endsWith("client-a"))!;
    expect(a.data).toMatchObject({
      clientId: "client-a",
      clientDomain: "a.com",
      clientConfig: { tenant: "A" },
    });
  });

  it("does not fan out a job that already carries a clientId — it runs the handler", async () => {
    const scheduler = new Scheduler();
    await scheduler.start();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerHandler("vitals:check-all-sources", handler);

    bull.queueAdds.length = 0;
    const def = jobDefinitions.find((j) => j.name === "vitals:check-all-sources");
    const processor = bull.processors.get("l9-web-vitals")!;
    await processor({ id: "p1", name: def!.name, data: { definition: def, clientId: "client-a" } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bull.queueAdds.filter((a) => a.opts?.jobId).length).toBe(0); // no children
  });

  it("marks the execution failed and rethrows when the handler rejects", async () => {
    const scheduler = new Scheduler();
    await scheduler.start();
    scheduler.registerHandler(
      "vitals:check-all-sources",
      vi.fn().mockRejectedValue(new Error("handler boom")),
    );

    const def = jobDefinitions.find((j) => j.name === "vitals:check-all-sources");
    const processor = bull.processors.get("l9-web-vitals")!;
    await expect(
      processor({ id: "p1", name: def!.name, data: { definition: def, clientId: "client-a" } }),
    ).rejects.toThrow("handler boom");

    expect(dbState.updateSets.some((s) => s.status === "failed")).toBe(true);
  });
});

describe("Scheduler.stop — releases resources and resets the singleton (GAP-006)", () => {
  it("closes workers + queues, quits Redis, and clears the singleton", async () => {
    const scheduler = getScheduler();
    await scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    await scheduler.stop();

    expect(bull.closed.workers).toBeGreaterThanOrEqual(1);
    expect(bull.closed.queues).toBeGreaterThanOrEqual(1);
    expect(bull.closed.redisQuit).toBe(1);
    expect(scheduler.isRunning()).toBe(false);
    // Singleton was reset, so the next accessor builds a fresh instance.
    expect(getScheduler()).not.toBe(scheduler);
  });
});
