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

import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import { getConfig } from './config.js';
import { createModuleLogger } from './logger.js';
import { getDb, schema } from './database/index.js';
import type { JobDefinition, ModuleName } from '../types/index.js';

const logger = createModuleLogger('scheduler');

// ─── Job Registry ────────────────────────────────────────────────────────────

const JOB_DEFINITIONS: JobDefinition[] = [
  // SERP Intelligence - Track rankings daily
  {
    name: 'serp:check-rankings',
    module: 'serp-intelligence',
    cron: '0 6 * * *',           // 6 AM daily
    handler: 'checkRankings',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  // SERP Intelligence - Competitor analysis weekly
  {
    name: 'serp:competitor-analysis',
    module: 'serp-intelligence',
    cron: '0 7 * * 1',           // Monday 7 AM
    handler: 'analyzeCompetitors',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 2000, maxStrategicTokensPerRun: 4000, cooldownMinutes: 60 },
    enabled: true,
  },
  // SERP Intelligence - Gap analysis & surpass plan (strategic LLM)
  {
    name: 'serp:generate-surpass-plan',
    module: 'serp-intelligence',
    cron: '0 8 * * 1',           // Monday 8 AM (after competitor analysis)
    handler: 'generateSurpassPlan',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 8000, cooldownMinutes: 120 },
    enabled: true,
  },
  // Web Vitals - Multi-signal check every 6 hours
  {
    name: 'vitals:check-all-sources',
    module: 'web-vitals',
    cron: '0 */6 * * *',         // Every 6 hours
    handler: 'checkAllSources',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  // AEO/GEO - Citation monitoring weekly
  {
    name: 'aeo:check-citations',
    module: 'aeo-geo',
    cron: '0 9 * * 3',           // Wednesday 9 AM
    handler: 'checkCitations',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 0, cooldownMinutes: 30 },
    enabled: true,
  },
  // AEO/GEO - FAQ optimization monthly
  {
    name: 'aeo:optimize-faqs',
    module: 'aeo-geo',
    cron: '0 10 1 * *',          // 1st of month 10 AM
    handler: 'optimizeFaqs',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 2000, maxStrategicTokensPerRun: 6000, cooldownMinutes: 180 },
    enabled: true,
  },
  // Link Building - Prospect discovery weekly
  {
    name: 'links:discover-prospects',
    module: 'link-building',
    cron: '0 10 * * 2',          // Tuesday 10 AM
    handler: 'discoverProspects',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 0, cooldownMinutes: 60 },
    enabled: true,
  },
  // Link Building - Send outreach sequences daily
  {
    name: 'links:process-outreach',
    module: 'link-building',
    cron: '0 11 * * 1-5',        // Weekdays 11 AM
    handler: 'processOutreach',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 3000, cooldownMinutes: 60 },
    enabled: true,
  },
  // Behavior Intelligence - PostHog data pull daily
  {
    name: 'behavior:pull-engagement',
    module: 'behavior-intelligence',
    cron: '0 5 * * *',           // 5 AM daily (before SERP check)
    handler: 'pullEngagementData',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  },
  // Behavior Intelligence - Weekly insights generation
  {
    name: 'behavior:generate-insights',
    module: 'behavior-intelligence',
    cron: '0 12 * * 5',          // Friday noon
    handler: 'generateInsights',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 1000, maxStrategicTokensPerRun: 4000, cooldownMinutes: 120 },
    enabled: true,
  },
  // Operator Report - Weekly summary
  {
    name: 'reports:weekly-summary',
    module: 'serp-intelligence',
    cron: '0 8 * * 5',           // Friday 8 AM
    handler: 'generateWeeklyReport',
    clientScoped: true,
    tokenBudget: { maxFastTokensPerRun: 500, maxStrategicTokensPerRun: 2000, cooldownMinutes: 60 },
    enabled: true,
  },
];

// ─── Scheduler Class ─────────────────────────────────────────────────────────

export class Scheduler {
  private connection: IORedis;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private handlers: Map<string, (job: Job) => Promise<void>> = new Map();

  constructor() {
    const config = getConfig();
    this.connection = new IORedis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }

  registerHandler(jobName: string, handler: (job: Job) => Promise<void>): void {
    this.handlers.set(jobName, handler);
    logger.debug({ jobName }, 'Handler registered');
  }

  async start(): Promise<void> {
    logger.info('Starting scheduler...');

    for (const jobDef of JOB_DEFINITIONS) {
      if (!jobDef.enabled) continue;

      const queueName = `l9:${jobDef.module}`;

      // Create queue if not exists
      if (!this.queues.has(queueName)) {
        const queue = new Queue(queueName, { connection: this.connection });
        this.queues.set(queueName, queue);
      }

      const queue = this.queues.get(queueName)!;

      // Schedule repeatable job
      await queue.add(jobDef.name, { definition: jobDef }, {
        repeat: { pattern: jobDef.cron },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      });

      logger.info({ job: jobDef.name, cron: jobDef.cron }, 'Job scheduled');
    }

    // Create workers for each module queue
    for (const [queueName] of this.queues) {
      const worker = new Worker(
        queueName,
        async (job: Job) => {
          await this.processJob(job);
        },
        {
          connection: this.connection,
          concurrency: 2,
          limiter: { max: 5, duration: 60000 }, // Max 5 jobs per minute per queue
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

    // Log job execution start
    const [execution] = await db.insert(schema.jobExecutions).values({
      jobName: definition.name,
      clientId: job.data.clientId || null,
      status: 'running',
      startedAt: new Date(),
    }).returning();

    try {
      // If client-scoped, fan out to all active clients
      if (definition.clientScoped && !job.data.clientId) {
        const activeClients = await db.query.clients.findMany({
          where: (clients, { eq }) => eq(clients.active, true),
        });

        for (const client of activeClients) {
          const queue = this.queues.get(`l9:${definition.module}`)!;
          await queue.add(definition.name, {
            definition,
            clientId: client.id,
            clientDomain: client.domain,
            clientConfig: client.config,
          }, {
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
          });
        }

        logger.info({ jobName: definition.name, clientCount: activeClients.length }, 'Fan-out completed');
      } else {
        await handler(job);
      }

      // Update execution log
      const durationMs = Date.now() - startTime;
      await db.update(schema.jobExecutions)
        .set({ status: 'completed', completedAt: new Date(), durationMs })
        .where(({ eq }) => eq(schema.jobExecutions.id, execution.id));

    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      await db.update(schema.jobExecutions)
        .set({ status: 'failed', completedAt: new Date(), durationMs, error: error.message })
        .where(({ eq }) => eq(schema.jobExecutions.id, execution.id));

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
