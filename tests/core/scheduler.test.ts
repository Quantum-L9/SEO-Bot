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

import { deterministicJobId, isBullMqSafeJobId } from "../../src/core/job-id.js";
import {
  fanoutChildJobId,
  getScheduler,
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
      "child~repeat-vitals-1750000000000~client-1",
    );
    expect(fanoutChildJobId("repeat:vitals:1750000000000", "client-1")).toBe(
      "child~repeat-vitals-1750000000000~client-1",
    );
  });

  it("produces an id BullMQ will actually accept", () => {
    // The assertion above used to expect `child:repeat:vitals:...:client-1`,
    // which BullMQ rejects: a custom id may not contain `:`. A repeatable
    // parent's own id is `repeat:<name>:<ms>`, so EVERY scheduled fan-out threw
    // at `queue.add()` and the dedup protection above had never run. The test
    // was green because the queue in this file is a fake that accepts any id.
    //
    // `isBullMqSafeJobId` is pinned against a real Redis in
    // `tests/live/queue.live.test.ts`, so this is not one fake vouching for
    // another.
    expect(isBullMqSafeJobId(fanoutChildJobId("repeat:vitals:1750000000000", "client-1"))).toBe(
      true,
    );
    expect(isBullMqSafeJobId(fanoutChildJobId("p1", "a"))).toBe(true);
    // The shape it replaced, so the regression is named rather than implied.
    expect(isBullMqSafeJobId("child:repeat:vitals:1750000000000:client-1")).toBe(false);
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
    const enabled = jobDefinitions.filter((j) => j.enabled);
    expect(repeatAdds).toHaveLength(enabled.length);

    // The disabled site-mutating job must NOT be scheduled.
    expect(repeatAdds.some((a) => a.name === "serp:execute-surpass-plans")).toBe(false);

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
    expect(children).toHaveLength(2);
    // Deterministic child ids (idempotent on parent retry → no duplicate outreach).
    expect(children.map((c) => c.opts.jobId).sort()).toEqual([
      "child~parent-99~client-a",
      "child~parent-99~client-b",
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
    expect(bull.queueAdds.filter((a) => a.opts?.jobId)).toHaveLength(0); // no children
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

// ─── addJob idempotency (hardening contract C5) ──────────────────────────────

describe("Scheduler.addJob — deduplication key", () => {
  const definition = {
    name: "intel:test-job",
    module: "intelligence",
    cron: "0 0 * * *",
    handler: "h",
    clientScoped: false,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  };

  it("passes a caller-supplied jobId through to BullMQ", async () => {
    // BullMQ treats a job id as a dedupe key, so this is the whole of the retry
    // protection for consequence-of-a-row enqueues: without it a retried
    // handler sends the same outreach twice.
    const scheduler = new Scheduler();
    scheduler.registerDefinition(definition as never);

    const jobId = deterministicJobId("intel", "c1", "o1", "intel:test-job");
    await scheduler.addJob("intel:test-job", { clientId: "c1" }, { jobId });

    const add = bull.queueAdds.at(-1);
    expect(add?.opts?.jobId).toBe(jobId);
    expect(isBullMqSafeJobId(jobId)).toBe(true);
  });

  it("rejects a jobId BullMQ would reject, naming the rule", async () => {
    // The fake queue accepts anything, so without this the suite cannot tell a
    // usable dedup key from one that throws on contact with Redis — which is
    // exactly how `intel:<client>:<fingerprint>:<job>` shipped.
    const scheduler = new Scheduler();
    scheduler.registerDefinition(definition as never);

    await expect(
      scheduler.addJob("intel:test-job", { clientId: "c1" }, { jobId: "intel:c1:o1:job" }),
    ).rejects.toThrow(/not a valid BullMQ custom id/);
  });

  it("leaves jobId undefined when the caller supplies none", async () => {
    // An operator pressing a button twice on purpose should get two jobs; only
    // enqueues derived from a durable row need the key.
    const scheduler = new Scheduler();
    scheduler.registerDefinition(definition as never);

    await scheduler.addJob("intel:test-job", { clientId: "c1" });

    const add = bull.queueAdds.at(-1);
    expect(add?.opts?.jobId).toBeUndefined();
  });

  it("keeps the retention bounds it always had", async () => {
    // Adding the dedupe key must not displace removeOnComplete/removeOnFail —
    // dropping those would grow the queue without bound.
    const scheduler = new Scheduler();
    scheduler.registerDefinition(definition as never);

    await scheduler.addJob("intel:test-job", {}, { jobId: "k" });

    const add = bull.queueAdds.at(-1);
    expect(add?.opts?.removeOnComplete).toEqual({ count: 100 });
    expect(add?.opts?.removeOnFail).toEqual({ count: 50 });
  });
});
