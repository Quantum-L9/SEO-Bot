import { describe, it, expect, vi } from 'vitest';

// scheduler.ts creates a module logger at import (→ getConfig) and imports
// bullmq/ioredis. Stub them so we can unit-test the pure id helper in isolation.
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({ REDIS_URL: 'redis://localhost:6379', BOT_TIMEZONE: 'UTC' }),
}));
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/core/database/index.js', () => ({ getDb: () => ({}), schema: {} }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('ioredis', () => ({ Redis: class {} }));

import { fanoutChildJobId } from '../../src/core/scheduler.js';

describe('fanoutChildJobId', () => {
  it('is deterministic per job/client/day regardless of time of day', () => {
    const morning = new Date('2026-07-18T09:00:00Z');
    const night = new Date('2026-07-18T23:59:59Z');
    expect(fanoutChildJobId('serp:check-rankings', 'client-1', morning)).toBe(
      'serp:check-rankings:client-1:2026-07-18',
    );
    // Same id later the same UTC day → a retried fan-out is deduped by BullMQ.
    expect(fanoutChildJobId('serp:check-rankings', 'client-1', night)).toBe(
      'serp:check-rankings:client-1:2026-07-18',
    );
  });

  it('differs by client and by day', () => {
    const d = new Date('2026-07-18T09:00:00Z');
    expect(fanoutChildJobId('j', 'a', d)).not.toBe(fanoutChildJobId('j', 'b', d));
    expect(fanoutChildJobId('j', 'a', d)).not.toBe(
      fanoutChildJobId('j', 'a', new Date('2026-07-19T09:00:00Z')),
    );
  });
});
