/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Job Scheduler
 * BullMQ-based job queue with cron scheduling, per-client fan-out,
 * token budget enforcement, and circuit breaker pattern.
 *
 * TOKEN EFFICIENCY:
 * - 95% of jobs are pure code (API calls, comparisons, DB writes) = zero tokens
 * - LLM is invoked ONLY when judgment is required
 * - Token budgets are enforced per-job to prevent runaway costs
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import type { JobDefinition } from "../types/index.js";
import { getConfig } from "./config.js";
import { getDb, schema } from "./database/index.js";
import { deterministicJobId, isBullMqSafeJobId } from "./job-id.js";
import { createModuleLogger } from "./logger.js";

const logger = createModuleLogger("scheduler");

/**
 * Deterministic BullMQ job id for a per-client fan-out child.
 *
 * BullMQ is at-least-once: if the parent fan-out job's worker crashes (or stalls
 * past its lock) after enqueuing some/all children but before it is marked
 * completed, BullMQ re-runs the SAME parent job instance — which would fan out a
 * second full set of children. Children auto-execute irreversible per-client
 * actions (outreach emails, directory submissions), so duplicates are harmful.
 *
 * Keying the child id on the PARENT job's instance id makes BullMQ ignore the
 * re-add on a retry (same parent id) while still letting every distinct
 * scheduled occurrence run: a job scheduled every 6 hours gets a NEW parent id
 * per fire, so its fan-out is not wrongly deduped across the day (a day-scoped
 * key would suppress all-but-the-first run).
 *
 * It used to build `child:<parent>:<client>`, which reads as three parts and
 * satisfied bullmq's legacy carve-out — until the parent is a repeatable job,
 * whose own id is `repeat:<name>:<ms>`. Then the child id has five colon parts
 * and `queue.add()` throws, so the fan-out this protects never happened at all.
 * Every scheduled fan-out has a repeatable parent, so that was the normal case,
 * not the edge one.
 */
export { deterministicJobId, isBullMqSafeJobId } from "./job-id.js";

export function fanoutChildJobId(parentJobId: string, clientId: string): string {
  return deterministicJobId("child", parentJobId, clientId);
}

// ─── Job Registry ────────────────────────────────────────────────────────────

const JOB_DEFINITIONS: JobDefinition[] = [
  {
    name: "serp:check-rankings",
    module: "serp-intelligence",
    cron: "0 6 * * *",
    handler: "checkRankings",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: "serp:competitor-analysis",
    module: "serp-intelligence",
    cron: "0 7 * * 1",
    handler: "analyzeCompetitors",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 2000, maxStrategicTokensPerRun: 4000, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: "serp:generate-surpass-plan",
    module: "serp-intelligence",
    cron: "0 8 * * 1",
    handler: "generateSurpassPlan",
    clientScoped: true,
    tokenBudget: {
      maxFastTokensPerRun: 1000,
      maxStrategicTokensPerRun: 8000,
      cooldownMinutes: 120,
    },
    enabled: true,
  },
  {
    // GAP-07 (C-02): executes status='planned' surpass plans via site-deployment.
    // DISABLED by default — it mutates the live site, so the operator must first
    // configure the site-write env vars (GITHUB_TOKEN with repo:write,
    // VERCEL_DEPLOY_HOOK, WEBSITE_BOT_REPO, SITE_SOURCE_BRANCH) and then flip
    // `enabled: true`. Handler is registered via registerPlanExecutorHandlers.
    name: "serp:execute-surpass-plans",
    module: "serp-intelligence",
    cron: "0 9 * * 1",
    handler: "executeSurpassPlans",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 60 },
    enabled: false,
  },
  {
    name: "vitals:check-all-sources",
    module: "web-vitals",
    cron: "0 */6 * * *",
    handler: "checkAllSources",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: "aeo:check-citations",
    module: "aeo-geo",
    cron: "0 9 * * 3",
    handler: "checkCitations",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 0, cooldownMinutes: 30 },
    enabled: true,
  },
  {
    name: "aeo:optimize-faqs",
    module: "aeo-geo",
    cron: "0 10 1 * *",
    handler: "optimizeFaqs",
    clientScoped: true,
    tokenBudget: {
      maxFastTokensPerRun: 2000,
      maxStrategicTokensPerRun: 6000,
      cooldownMinutes: 180,
    },
    enabled: true,
  },
  {
    name: "links:discover-prospects",
    module: "link-building",
    cron: "0 10 * * 2",
    handler: "discoverProspects",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 0, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: "links:process-outreach",
    module: "link-building",
    cron: "0 11 * * 1-5",
    handler: "processOutreach",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 3000, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: "behavior:pull-engagement",
    module: "behavior-intelligence",
    cron: "0 5 * * *",
    handler: "pullEngagementData",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: "behavior:generate-insights",
    module: "behavior-intelligence",
    cron: "0 12 * * 5",
    handler: "generateInsights",
    clientScoped: true,
    tokenBudget: {
      maxFastTokensPerRun: 1000,
      maxStrategicTokensPerRun: 4000,
      cooldownMinutes: 120,
    },
    enabled: true,
  },
  {
    name: "reports:weekly-summary",
    module: "serp-intelligence",
    cron: "0 8 * * 5",
    handler: "generateWeeklyReport",
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 2000, cooldownMinutes: 60 },
    enabled: true,
  },
];

// ─── Scheduler Class ─────────────────────────────────────────────────────────

export class Scheduler {
  private readonly connection: Redis;
  private readonly queues: Map<string, Queue> = new Map();
  private readonly workers: Map<string, Worker> = new Map();
  private readonly handlers: Map<string, (job: Job) => Promise<void>> = new Map();

  constructor() {
    const config = getConfig();
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }

  registerDefinition(definition: JobDefinition): void {
    const existing = JOB_DEFINITIONS.find((item) => item.name === definition.name);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(definition))
        throw new Error(`Conflicting job definition: ${definition.name}`);
      return;
    }
    JOB_DEFINITIONS.push(definition);
    logger.debug({ jobName: definition.name }, "Job definition registered");
  }

  registerHandler(jobName: string, handler: (job: Job) => Promise<void>): void {
    this.handlers.set(jobName, handler);
    logger.debug({ jobName }, "Handler registered");
  }

  /**
   * Queue a job outside its cron schedule.
   *
   * `opts.jobId` makes the enqueue IDEMPOTENT: BullMQ treats a job id as a
   * deduplication key, so a retried caller re-queues nothing rather than
   * producing a second copy of the same work. Callers that enqueue as a
   * consequence of a durable database row — the intelligence plane's follow-up
   * jobs, which are queued after a proposal is logged — MUST pass one derived
   * from that row, because their own retry is exactly the case that would
   * otherwise duplicate an outreach send or a plan.
   *
   * Omitting it keeps BullMQ's default of a fresh id per call, which is right
   * for an operator pressing a button twice on purpose.
   */
  async addJob(
    jobName: string,
    data: Record<string, unknown>,
    opts: { jobId?: string } = {},
  ): Promise<void> {
    const jobDef = JOB_DEFINITIONS.find((j) => j.name === jobName);
    if (!jobDef) {
      throw new Error(`Unknown job: ${jobName}`);
    }
    // Fail here, naming the rule, rather than inside bullmq's `Custom Id cannot
    // contain :`. A caller that hand-builds an id is the caller that needs to
    // be told about `deterministicJobId`.
    if (opts.jobId !== undefined && !isBullMqSafeJobId(opts.jobId)) {
      throw new Error(
        `Job id "${opts.jobId}" is not a valid BullMQ custom id (no ":", not all digits). ` +
          "Build it with deterministicJobId().",
      );
    }
    const queueName = `l9-${jobDef.module}`;
    // FIX(T-A): Initialize queue on-demand — handles disabled jobs skipped during startup.
    // Without this, addJob() throws if the job was disabled and its queue was never created.
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection as ConnectionOptions });
      this.queues.set(queueName, queue);
    }
    await queue.add(
      jobName,
      { definition: jobDef, ...data },
      {
        // Undefined leaves BullMQ's default (a generated id per call) in place.
        jobId: opts.jobId,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    );
    // Log only jobName and the dedupe key — data contains clientConfig and may
    // include secrets/PII. The jobId is derived from row ids, never from payload.
    logger.info({ jobName, jobId: opts.jobId }, "Manual job queued");
  }

  async start(): Promise<void> {
    logger.info("Starting scheduler...");

    for (const jobDef of JOB_DEFINITIONS) {
      if (!jobDef.enabled) continue;

      const queueName = `l9-${jobDef.module}`;

      if (!this.queues.has(queueName)) {
        const queue = new Queue(queueName, { connection: this.connection as ConnectionOptions });
        this.queues.set(queueName, queue);
      }

      const queue = this.queues.get(queueName);
      if (!queue) throw new Error(`queue ${queueName} is not registered`);

      await queue.add(
        jobDef.name,
        { definition: jobDef },
        {
          repeat: { pattern: jobDef.cron },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      );

      logger.info({ job: jobDef.name, cron: jobDef.cron }, "Job scheduled");
    }

    for (const [queueName] of this.queues) {
      const worker = new Worker(
        queueName,
        async (job: Job) => {
          await this.processJob(job);
        },
        {
          connection: this.connection as ConnectionOptions,
          concurrency: 2,
          limiter: { max: 5, duration: 60000 },
        },
      );

      worker.on("completed", (job) => {
        logger.info({ jobId: job.id, name: job.name }, "Job completed");
      });

      worker.on("failed", (job, err) => {
        logger.error({ jobId: job?.id, name: job?.name, err: err.message }, "Job failed");
      });

      this.workers.set(queueName, worker);
    }

    logger.info(
      { queues: this.queues.size, jobs: JOB_DEFINITIONS.filter((j) => j.enabled).length },
      "Scheduler started",
    );
  }

  private async processJob(job: Job): Promise<void> {
    const definition: JobDefinition = job.data.definition;
    const handler = this.handlers.get(definition.name);

    if (!handler) {
      logger.warn({ jobName: definition.name }, "No handler registered for job");
      return;
    }

    const db = getDb();
    const startTime = Date.now();

    const [execution] = await db
      .insert(schema.jobExecutions)
      .values({
        jobName: definition.name,
        clientId: job.data.clientId || null,
        status: "running",
        startedAt: new Date(),
      })
      .returning();

    try {
      if (definition.clientScoped && !job.data.clientId) {
        const activeClients = await db
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.active, true));

        // Parent job instance id — stable across retries of THIS fire, unique
        // per scheduled occurrence, so the child dedup below is idempotent on
        // retry without suppressing later scheduled runs.
        const parentJobId = job.id ?? definition.name;

        for (const client of activeClients) {
          const queue = this.queues.get(`l9-${definition.module}`);
          if (!queue) continue;
          await queue.add(
            definition.name,
            {
              definition,
              clientId: client.id,
              clientDomain: client.domain,
              clientConfig: client.config,
            },
            {
              // Deterministic id → a retried parent fan-out does not double-enqueue
              // this client's child job (idempotency; prevents duplicate outreach).
              jobId: fanoutChildJobId(parentJobId, client.id),
              removeOnComplete: { count: 100 },
              removeOnFail: { count: 50 },
            },
          );
        }

        logger.info(
          { jobName: definition.name, clientCount: activeClients.length },
          "Fan-out completed",
        );
      } else {
        await handler(job);
      }

      const durationMs = Date.now() - startTime;
      await db
        .update(schema.jobExecutions)
        .set({ status: "completed", completedAt: new Date(), durationMs })
        .where(eq(schema.jobExecutions.id, execution.id));
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      await db
        .update(schema.jobExecutions)
        .set({
          status: "failed",
          completedAt: new Date(),
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(schema.jobExecutions.id, execution.id));

      throw error;
    }
  }

  isRunning(): boolean {
    return this.workers.size > 0;
  }

  async stop(): Promise<void> {
    logger.info("Stopping scheduler...");
    for (const [, worker] of this.workers) {
      await worker.close();
    }
    for (const [, queue] of this.queues) {
      await queue.close();
    }
    await this.connection.quit();
    this.workers.clear();
    this.queues.clear();
    logger.info("Scheduler stopped");
    // Reset singleton so next getScheduler() call creates a fresh instance
    if (_scheduler === this) {
      _scheduler = null;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  _scheduler ??= new Scheduler();
  return _scheduler;
}

/**
 * Jobs that may be triggered outside their cron schedule — by an operator via
 * POST /api/clients/:clientId/trigger, or by the intelligence plane's action
 * planner.
 *
 * This is the single allow-list for both callers. It deliberately EXCLUDES
 * `serp:execute-surpass-plans` (the gated live-site write path, AGENTS §9) and
 * `reports:weekly-summary`, neither of which should be reachable by an
 * on-demand trigger.
 */
export const TRIGGERABLE_JOBS: readonly string[] = [
  "serp:check-rankings",
  "serp:competitor-analysis",
  "serp:generate-surpass-plan",
  "vitals:check-all-sources",
  "aeo:check-citations",
  "aeo:optimize-faqs",
  "links:discover-prospects",
  "links:process-outreach",
  "behavior:pull-engagement",
  "behavior:generate-insights",
] as const;

export function isTriggerableJob(jobName: string): boolean {
  return TRIGGERABLE_JOBS.includes(jobName);
}

export const jobDefinitions = JOB_DEFINITIONS;
