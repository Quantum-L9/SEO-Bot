/* L9_META
 * layer: test
 * role: live_integration_test
 * status: active
 */

/**
 * The dedup key, against real BullMQ on real Redis.
 *
 * This is the defect that started the whole 4th-contract review: the key was
 * derived from an outcome row inserted fresh on every pass, so it was different
 * every time and deduplicated nothing. It now keys on the opportunity
 * fingerprint, which is stable by construction (client + type + target).
 *
 * The fix was verified against a fake queue — and the first version of that
 * fake reused row ids, so the test passed against the BROKEN key until the fake
 * was corrected. Correcting a fake proves the fake. Only Redis proves that
 * BullMQ collapses two `add()` calls sharing a `jobId`, which is the property
 * the whole argument rests on and which no test in this repo had ever exercised.
 */

import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deterministicJobId, isBullMqSafeJobId } from "../../src/core/job-id.js";
import { fanoutChildJobId } from "../../src/core/scheduler.js";
import { opportunityFingerprint } from "../../src/intelligence/types.js";
import { liveServicesUnavailable, REDIS_URL, redisClient } from "./services.js";

const skip = await liveServicesUnavailable();

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";
const QUEUE_NAME = `l9-live-test-${process.pid}`;

describe.skipIf(skip)("BullMQ dedup on real Redis", () => {
  let queue: Queue;

  beforeAll(() => {
    queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  /** The exact key `queueFollowUp` builds in `src/intelligence/runner.ts`. */
  function jobIdFor(groupKey: string, job = "link:send-outreach") {
    const fingerprint = opportunityFingerprint(CLIENT, "link_outreach_batch", groupKey);
    return deterministicJobId("intel", CLIENT, fingerprint, job);
  }

  it("collapses two adds that share a jobId into ONE job", async () => {
    const jobId = jobIdFor("live-dedup-group");
    const first = await queue.add("link:send-outreach", { clientId: CLIENT }, { jobId });
    const second = await queue.add("link:send-outreach", { clientId: CLIENT }, { jobId });

    // BullMQ returns a Job for both calls; the question is whether there are
    // two jobs in Redis or one. `getJobCounts` is the answer that matters,
    // because it is the queue a worker would drain.
    expect(first.id).toBe(second.id);
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    expect(counts.waiting + counts.active + counts.delayed).toBe(1);
  });

  it("keeps a DIFFERENT opportunity's job, so dedup is not a global mute", async () => {
    // The failure mode opposite to the original bug: a key so stable it
    // suppresses unrelated work. Two different targets must stay two jobs.
    await queue.add("link:send-outreach", { clientId: CLIENT }, { jobId: jobIdFor("group-a") });
    await queue.add("link:send-outreach", { clientId: CLIENT }, { jobId: jobIdFor("group-b") });
    const ids = (await queue.getJobs(["waiting", "delayed", "active"])).map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(jobIdFor("group-a"));
    expect(ids).toContain(jobIdFor("group-b"));
  });

  it("derives the same key from the same opportunity across processes", async () => {
    // The two-concurrent-runs case status suppression does not cover: both runs
    // load the open fingerprints before either marks the opportunity actioned,
    // so both propose. Only a key that is identical in two separate processes
    // stops both from sending. It is a hash of values, with no clock and no row
    // id in it — asserted, since a future refactor reaching for either would
    // reintroduce exactly the defect this replaced.
    expect(jobIdFor("same-target")).toBe(jobIdFor("same-target"));
    expect(jobIdFor("same-target")).not.toBe(jobIdFor("other-target"));
  });

  it("accepts exactly what isBullMqSafeJobId accepts, and rejects what it rejects", async () => {
    // The load-bearing test in this file, and the reason the predicate is not
    // just one more fake vouching for another. Every queue in `tests/` is a
    // `vi.fn()`; this is the only place the rule meets the implementation.
    //
    // The rejected shapes below are not hypothetical. Both shipped:
    //   runner.ts     `intel:<client>:<fingerprint>:<job>`
    //   scheduler.ts  `child:repeat:<name>:<ms>:<client>`
    // Both threw at `queue.add()`, so the dedup protection each was written for
    // had never once run, and every unit test around them was green.
    const shouldPass = [
      jobIdFor("live-agreement"),
      fanoutChildJobId("repeat:vitals:1750000000000", CLIENT),
      deterministicJobId("intel", CLIENT, "abc123", "aeo:optimize-faqs"),
    ];
    for (const jobId of shouldPass) {
      expect(isBullMqSafeJobId(jobId), `${jobId}: predicate says no`).toBe(true);
      await expect(
        queue.add("link:send-outreach", { clientId: CLIENT }, { jobId }),
        `${jobId}: predicate said yes, BullMQ disagreed`,
      ).resolves.toBeDefined();
    }

    const shouldFail = [
      `intel:${CLIENT}:abc123:link:send-outreach`,
      "child:repeat:vitals:1750000000000:client-1",
      "12345",
    ];
    for (const jobId of shouldFail) {
      expect(isBullMqSafeJobId(jobId), `${jobId}: predicate says yes`).toBe(false);
      await expect(
        queue.add("link:send-outreach", { clientId: CLIENT }, { jobId }),
        `${jobId}: predicate said no, BullMQ accepted it`,
      ).rejects.toThrow();
    }
  });

  it("talks to a Redis that is actually there", async () => {
    // Guards the suite itself: every assertion above would also pass against a
    // queue that quietly buffered in memory.
    const redis = redisClient();
    try {
      expect(await redis.ping()).toBe("PONG");
      const keys = await redis.keys(`bull:${QUEUE_NAME}:*`);
      expect(keys.length, "no BullMQ keys in Redis — nothing was really queued").toBeGreaterThan(0);
    } finally {
      redis.disconnect();
    }
  });
});
