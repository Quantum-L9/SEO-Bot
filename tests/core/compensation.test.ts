import { describe, it, expect, vi } from 'vitest';

// compensation.ts creates a module logger at import (→ getConfig). Stub the
// logger so the registry can be unit-tested without a full config env.
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CompensationRegistry } from '../../src/core/compensation.js';

describe('CompensationRegistry', () => {
  it('runs compensations in LIFO order', async () => {
    const registry = new CompensationRegistry('job-1', 'client-1');
    const order: string[] = [];
    registry.register('first', async () => { order.push('first'); });
    registry.register('second', async () => { order.push('second'); });
    registry.register('third', async () => { order.push('third'); });

    const results = await registry.compensate();

    // Reverse of registration order — the last mutation is undone first.
    expect(order).toEqual(['third', 'second', 'first']);
    expect(results.map((r) => r.stepId)).toEqual(['third', 'second', 'first']);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it('isolates a failing compensation and still runs the rest', async () => {
    const registry = new CompensationRegistry('job-2');
    const ran: string[] = [];
    registry.register('ok-1', async () => { ran.push('ok-1'); });
    registry.register('boom', async () => { throw new Error('revert failed'); });
    registry.register('ok-2', async () => { ran.push('ok-2'); });

    const results = await registry.compensate();

    // LIFO: ok-2 runs, boom fails but does not abort, ok-1 still runs.
    expect(ran).toEqual(['ok-2', 'ok-1']);
    const boom = results.find((r) => r.stepId === 'boom');
    expect(boom?.error).toBe('revert failed');
    expect(results.filter((r) => r.error === undefined).map((r) => r.stepId)).toEqual(['ok-2', 'ok-1']);
  });

  it('clear() drops registered entries so nothing compensates', async () => {
    const registry = new CompensationRegistry('job-3');
    const ran: string[] = [];
    registry.register('a', async () => { ran.push('a'); });
    expect(registry.size).toBe(1);

    registry.clear();
    expect(registry.size).toBe(0);

    const results = await registry.compensate();
    expect(results).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('tracks size as entries are registered', () => {
    const registry = new CompensationRegistry('job-4');
    expect(registry.size).toBe(0);
    registry.register('a', async () => {});
    registry.register('b', async () => {});
    expect(registry.size).toBe(2);
  });
});
