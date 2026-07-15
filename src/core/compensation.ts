/**
 * CompensationRegistry — saga-pattern rollback for external mutations in SEO Bot.
 *
 * Covers: external SEO provider writes, outreach API calls, Postgres state writes,
 * client-snippet pushes, and any future live-site mutations.
 *
 * Rule: register compensation BEFORE executing the mutating step.
 * On failure, call compensate() to reverse registered actions in LIFO order.
 */

import { logger } from './logger.js';

export interface CompensationEntry {
  stepId: string;
  clientId?: string;
  action: () => Promise<void>;
  registeredAt: Date;
}

export class CompensationRegistry {
  private readonly entries: CompensationEntry[] = [];

  constructor(
    public readonly jobId: string,
    public readonly clientId?: string,
  ) {}

  /**
   * Register a compensation action for a step about to mutate external state.
   * Always call this BEFORE the mutation, not after.
   */
  register(stepId: string, action: () => Promise<void>): void {
    this.entries.push({ stepId, clientId: this.clientId, action, registeredAt: new Date() });
    logger.debug({ jobId: this.jobId, stepId, clientId: this.clientId }, 'compensation:registered');
  }

  /**
   * Execute all compensations in reverse order (LIFO).
   * Errors in individual compensations are collected but do not abort others.
   */
  async compensate(): Promise<{ stepId: string; error?: string }[]> {
    const results: { stepId: string; error?: string }[] = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        await entry.action();
        results.push({ stepId: entry.stepId });
        logger.info({ jobId: this.jobId, stepId: entry.stepId }, 'compensation:ok');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ stepId: entry.stepId, error: message });
        logger.error({ jobId: this.jobId, stepId: entry.stepId, message }, 'compensation:failed');
      }
    }
    return results;
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
