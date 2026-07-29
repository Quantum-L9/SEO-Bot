import { describe, it, expect } from 'vitest';
import { scheduleGates, resolveGateConcurrency, type SchedulableGate } from '../../scripts/validation/core/gate-scheduler.js';

// Mirrors the ci-profile gate DAG: preflight -> source -> {typecheck,lint,test,
// manifest,claims}; build -> typecheck; database -> build.
const CI_DAG: Array<[string, string[]]> = [
  ['preflight', []],
  ['source', ['preflight']],
  ['typecheck', ['source']],
  ['lint', ['source']],
  ['test', ['source']],
  ['manifest', ['source']],
  ['claims', ['source']],
  ['build', ['typecheck']],
  ['database', ['build']],
];

function dag(entries: Array<[string, string[]]>): {
  order: string[];
  byId: Map<string, SchedulableGate>;
} {
  const byId = new Map<string, SchedulableGate>(entries.map(([id, deps]) => [id, { dependencies: deps }]));
  return { order: entries.map(([id]) => id), byId };
}

interface Result {
  gateId: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('scheduleGates', () => {
  it('never starts a gate before all of its dependencies have completed', async () => {
    const { order, byId } = dag(CI_DAG);
    const completed = new Set<string>();
    const violations: string[] = [];

    await scheduleGates<Result>(order, byId, {
      concurrency: 4,
      isSatisfied: (r) => r.status === 'PASS',
      onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
      runGate: async (gateId) => {
        for (const dep of byId.get(gateId)!.dependencies) {
          if (!completed.has(dep)) violations.push(`${gateId} started before ${dep}`);
        }
        await delay(5);
        completed.add(gateId);
        return { gateId, status: 'PASS' };
      },
    });

    expect(violations).toEqual([]);
    expect(completed.size).toBe(order.length);
  });

  it('never exceeds the concurrency cap', async () => {
    const { order, byId } = dag(CI_DAG);
    let live = 0;
    let maxLive = 0;

    await scheduleGates<Result>(order, byId, {
      concurrency: 2,
      isSatisfied: (r) => r.status === 'PASS',
      onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
      runGate: async (gateId) => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await delay(5);
        live -= 1;
        return { gateId, status: 'PASS' };
      },
    });

    expect(maxLive).toBeLessThanOrEqual(2);
    expect(maxLive).toBeGreaterThan(1); // the independent gates DID overlap
  });

  it('runs the five independent ci gates concurrently under a wide cap', async () => {
    const { order, byId } = dag(CI_DAG);
    let live = 0;
    let maxLive = 0;
    await scheduleGates<Result>(order, byId, {
      concurrency: 5,
      isSatisfied: (r) => r.status === 'PASS',
      onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
      runGate: async (gateId) => {
        live += 1; maxLive = Math.max(maxLive, live);
        await delay(10);
        live -= 1;
        return { gateId, status: 'PASS' };
      },
    });
    // typecheck, lint, test, manifest, claims all depend only on source.
    expect(maxLive).toBe(5);
  });

  it('blocks dependents of a failed gate and cascades without executing them', async () => {
    const { order, byId } = dag(CI_DAG);
    const ran: string[] = [];
    const results = await scheduleGates<Result>(order, byId, {
      concurrency: 4,
      isSatisfied: (r) => r.status === 'PASS',
      onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
      runGate: async (gateId) => {
        ran.push(gateId);
        // Fail typecheck → build and database must become BLOCKED and never run.
        return { gateId, status: gateId === 'typecheck' ? 'FAIL' : 'PASS' };
      },
    });

    expect(ran).not.toContain('build');
    expect(ran).not.toContain('database');
    expect(results.get('build')?.status).toBe('BLOCKED');
    expect(results.get('database')?.status).toBe('BLOCKED'); // cascaded through build
    expect(results.get('lint')?.status).toBe('PASS'); // sibling unaffected
    expect(results.size).toBe(order.length);
  });

  it('with concurrency 1 completes in exact gateOrder (serial-equivalent)', async () => {
    const { order, byId } = dag(CI_DAG);
    const completionOrder: string[] = [];
    await scheduleGates<Result>(order, byId, {
      concurrency: 1,
      isSatisfied: (r) => r.status === 'PASS',
      onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
      runGate: async (gateId) => {
        await delay(2);
        completionOrder.push(gateId);
        return { gateId, status: 'PASS' };
      },
    });
    expect(completionOrder).toEqual(order);
  });

  it('propagates a runGate rejection', async () => {
    const { order, byId } = dag([['a', []]]);
    await expect(
      scheduleGates<Result>(order, byId, {
        concurrency: 1,
        isSatisfied: () => true,
        onDependencyBlocked: (gateId) => ({ gateId, status: 'BLOCKED' }),
        runGate: async () => { throw new Error('boom'); },
      }),
    ).rejects.toThrow('boom');
  });
});

describe('resolveGateConcurrency', () => {
  it('honors a valid positive integer override', () => {
    expect(resolveGateConcurrency({ VALIDATION_CONCURRENCY: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveGateConcurrency({ VALIDATION_CONCURRENCY: '1' } as NodeJS.ProcessEnv)).toBe(1);
  });

  it('ignores invalid overrides and falls back to a bounded default', () => {
    for (const bad of ['0', '-2', 'abc', '', '  ']) {
      const n = resolveGateConcurrency({ VALIDATION_CONCURRENCY: bad } as NodeJS.ProcessEnv);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(4);
    }
  });

  it('defaults to a bounded value when unset', () => {
    const n = resolveGateConcurrency({} as NodeJS.ProcessEnv);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });
});
