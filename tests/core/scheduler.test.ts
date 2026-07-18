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
  it('is stable for the same parent job id + client (retry dedup)', () => {
    // Same parent instance id (a retry of the same fire) → same child id, so
    // BullMQ ignores the re-add and the child is not run twice.
    expect(fanoutChildJobId('repeat:vitals:1750000000000', 'client-1')).toBe(
      'child:repeat:vitals:1750000000000:client-1',
    );
    expect(fanoutChildJobId('repeat:vitals:1750000000000', 'client-1')).toBe(
      'child:repeat:vitals:1750000000000:client-1',
    );
  });

  it('differs across scheduled occurrences so every fire still runs', () => {
    // Every-6-hours job → distinct parent ids per fire → distinct child ids,
    // so later runs the same day are NOT wrongly deduped.
    expect(fanoutChildJobId('repeat:vitals:1750000000000', 'c1'))
      .not.toBe(fanoutChildJobId('repeat:vitals:1750021600000', 'c1'));
  });

  it('differs by client', () => {
    expect(fanoutChildJobId('p1', 'a')).not.toBe(fanoutChildJobId('p1', 'b'));
  });
});
