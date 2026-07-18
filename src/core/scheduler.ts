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

import { Queue, Worker, Job, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { getConfig } from './config.js';
import { createModuleLogger } from './logger.js';
import { getDb, schema } from './database/index.js';
import type { JobDefinition, ModuleName } from '../types/index.js';

const logger = createModuleLogger('scheduler');

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
 */
export function fanoutChildJobId(parentJobId: string, clientId: string): string {
  return `child:${parentJobId}:${clientId}`;
}

// ─── Job Registry ────────────────────────────────────────────────────────────

const JOB_DEFINITIONS: JobDefinition[] = [
  {
    name: 'serp:check-rankings',
    module: 'serp-intelligence',
    cron: '0 6 * * *',
    handler: 'checkRankings',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: 'serp:competitor-analysis',
    module: 'serp-intelligence',
    cron: '0 7 * * 1',
    handler: 'analyzeCompetitors',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 2000, maxStrategicTokensPerRun: 4000, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: 'serp:generate-surpass-plan',
    module: 'serp-intelligence',
    cron: '0 8 * * 1',
    handler: 'generateSurpassPlan',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 8000, cooldownMinutes: 120 },
    enabled: true,
  },
  {
    // GAP-07 (C-02): executes status='planned' surpass plans via site-deployment.
    // DISABLED by default — it mutates the live site, so the operator must first
    // configure the site-write env vars (GITHUB_TOKEN with repo:write,
    // VERCEL_DEPLOY_HOOK, WEBSITE_BOT_REPO, SITE_SOURCE_BRANCH) and then flip
    // `enabled: true`. Handler is registered via registerPlanExecutorHandlers.
    name: 'serp:execute-surpass-plans',
    module: 'serp-intelligence',
    cron: '0 9 * * 1',
    handler: 'executeSurpassPlans',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 60 },
    enabled: false,
  },
  {
    name: 'vitals:check-all-sources',
    module: 'web-vitals',
    cron: '0 */6 * * *',
    handler: 'checkAllSources',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: 'aeo:check-citations',
    module: 'aeo-geo',
    cron: '0 9 * * 3',
    handler: 'checkCitations',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 0, cooldownMinutes: 30 },
    enabled: true,
  },
  {
    name: 'aeo:optimize-faqs',
    module: 'aeo-geo',
    cron: '0 10 1 * *',
    handler: 'optimizeFaqs',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 2000, maxStrategicTokensPerRun: 6000, cooldownMinutes: 180 },
    enabled: true,
  },
  {
    name: 'links:discover-prospects',
    module: 'link-building',
    cron: '0 10 * * 2',
    handler: 'discoverProspects',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 0, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: 'links:process-outreach',
    module: 'link-building',
    cron: '0 11 * * 1-5',
    handler: 'processOutreach',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 3000, cooldownMinutes: 60 },
    enabled: true,
  },
  {
    name: 'behavior:pull-engagement',
    module: 'behavior-intelligence',
    cron: '0 5 * * *',
    handler: 'pullEngagementData',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  {
    name: 'behavior:generate-insights',
    module: 'behavior-intelligence',
    cron: '0 12 * * 5',
    handler: 'generateInsights',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 4000, cooldownMinutes: 120 },
    enabled: true,
  },
  {
    name: 'reports:weekly-summary',
    module: 'serp-intelligence',
    cron: '0 8 * * 5',
    handler: 'generateWeeklyReport',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 2000, cooldownMinutes: 60 },
    enabled: true,
  },
];

// ─── Scheduler Class ─────────────────────────────────────────────────────────

export class Scheduler {
  private connection: Redis;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private handlers: Map<string, (job: Job) => Promise<void>> = new Map();

  constructor() {
    const config = getConfig();
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }

  registerHandler(jobName: string, handler: (job: Job) => Promise<void>): void {
    this.handlers.set(jobName, handler);
    logger.debug({ jobName }, 'Handler registered');
  }

  async addJob(jobName: string, data: Record<string, unknown>): Promise<void> {
    const jobDef = JOB_DEFINITIONS.find(j => j.name === jobName);
    if (!jobDef) {
      throw new Error(`Unknown job: ${jobName}`);
    }
    const queueName = `l9-${jobDef.module}`;
    // FIX(T-A): Initialize queue on-demand — handles disabled jobs skipped during startup.
    // Without this, addJob() throws if the job was disabled and its queue was never created.
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection as ConnectionOptions });
      this.queues.set(queueName, queue);
    }
    await queue.add(jobName, { definition: jobDef, ...data }, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    });
    // Log only jobName — data contains clientConfig and may include secrets/PII
    logger.info({ jobName }, 'Manual job queued');
  }

  async start(): Promise<void> {
    logger.info('Starting scheduler...');

    for (const jobDef of JOB_DEFINITIONS) {
      if (!jobDef.enabled) continue;

      const queueName = `l9-${jobDef.module}`;

      if (!this.queues.has(queueName)) {
        const queue = new Queue(queueName, { connection: this.connection as ConnectionOptions });
        this.queues.set(queueName, queue);
      }

      const queue = this.queues.get(queueName)!;

      await queue.add(jobDef.name, { definition: jobDef }, {
        repeat: { pattern: jobDef.cron },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      });

      logger.info({ job: jobDef.name, cron: jobDef.cron }, 'Job scheduled');
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
        }
      );

      worker.on('completed', (job) => {
        logger.info({ jobId: job.id, name: job.name }, 'Job completed');
      });

      worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Job failed');
      });

      this.workers.set(queueName, worker);
    }

    logger.info({ queues: this.queues.size, jobs: JOB_DEFINITIONS.filter(j => j.enabled).length }, 'Scheduler started');
  }

  private async processJob(job: Job): Promise<void> {
    const definition: JobDefinition = job.data.definition;
    const handler = this.handlers.get(definition.name);

    if (!handler) {
      logger.warn({ jobName: definition.name }, 'No handler registered for job');
      return;
    }

    const db = getDb();
    const startTime = Date.now();

    const [execution] = await db.insert(schema.jobExecutions).values({
      jobName: definition.name,
      clientId: job.data.clientId || null,
      status: 'running',
      startedAt: new Date(),
    }).returning();

    try {
      if (definition.clientScoped && !job.data.clientId) {
        const activeClients = await db.select().from(schema.clients)
          .where(eq(schema.clients.active, true));

        // Parent job instance id — stable across retries of THIS fire, unique
        // per scheduled occurrence, so the child dedup below is idempotent on
        // retry without suppressing later scheduled runs.
        const parentJobId = job.id ?? definition.name;

        for (const client of activeClients) {
          const queue = this.queues.get(`l9-${definition.module}`)!;
          await queue.add(definition.name, {
            definition,
            clientId: client.id,
            clientDomain: client.domain,
            clientConfig: client.config,
          }, {
            // Deterministic id → a retried parent fan-out does not double-enqueue
            // this client's child job (idempotency; prevents duplicate outreach).
            jobId: fanoutChildJobId(parentJobId, client.id),
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
          });
        }

        logger.info({ jobName: definition.name, clientCount: activeClients.length }, 'Fan-out completed');
      } else {
        await handler(job);
      }

      const durationMs = Date.now() - startTime;
      await db.update(schema.jobExecutions)
        .set({ status: 'completed', completedAt: new Date(), durationMs })
        .where(eq(schema.jobExecutions.id, execution.id));

    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      await db.update(schema.jobExecutions)
        .set({ status: 'failed', completedAt: new Date(), durationMs, error: error.message })
        .where(eq(schema.jobExecutions.id, execution.id));

      throw error;
    }
  }

  isRunning(): boolean {
    return this.workers.size > 0;
  }

  async stop(): Promise<void> {
    logger.info('Stopping scheduler...');
    for (const [, worker] of this.workers) {
      await worker.close();
    }
    for (const [, queue] of this.queues) {
      await queue.close();
    }
    await this.connection.quit();
    this.workers.clear();
    this.queues.clear();
    logger.info('Scheduler stopped');
    // Reset singleton so next getScheduler() call creates a fresh instance
    if (_scheduler === this) {
      _scheduler = null;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!_scheduler) {
    _scheduler = new Scheduler();
  }
  return _scheduler;
}

export const jobDefinitions = JOB_DEFINITIONS;
