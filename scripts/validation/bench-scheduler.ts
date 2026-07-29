/**
 * Deterministic wall-clock benchmark for the validation gate scheduler.
 *
 * Runs the ci-profile gate DAG twice — serial (concurrency 1, the previous
 * runner's behavior) and bounded-concurrent (default cap) — with representative
 * synthetic per-gate durations, and reports the wall-clock delta. This measures
 * ONLY the scheduling change: real gate durations vary by machine and toolchain,
 * so the absolute numbers are illustrative; the ratio reflects the parallelism
 * unlocked by running independent gates concurrently.
 *
 * Run: tsx scripts/validation/bench-scheduler.ts
 */
import { performance } from 'node:perf_hooks';
import { scheduleGates, type SchedulableGate } from './core/gate-scheduler.js';

// [id, dependencies, representative duration ms]. Durations mirror the relative
// cost profile of the real gates (test heaviest; manifest/claims light).
const CI_GATES: Array<[string, string[], number]> = [
  ['preflight', [], 40],
  ['source', ['preflight'], 120],
  ['typecheck', ['source'], 400],
  ['lint', ['source'], 300],
  ['test', ['source'], 900],
  ['manifest', ['source'], 80],
  ['claims', ['source'], 90],
  ['build', ['typecheck'], 350],
  ['database', ['build'], 500],
];

const order = CI_GATES.map(([id]) => id);
const byId = new Map<string, SchedulableGate>(CI_GATES.map(([id, deps]) => [id, { dependencies: deps }]));
const durationOf = new Map<string, number>(CI_GATES.map(([id, , ms]) => [id, ms]));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(concurrency: number): Promise<number> {
  const start = performance.now();
  await scheduleGates<{ status: 'PASS' }>(order, byId, {
    concurrency,
    isSatisfied: () => true,
    onDependencyBlocked: () => ({ status: 'PASS' }),
    runGate: async (gateId) => {
      await delay(durationOf.get(gateId) ?? 0);
      return { status: 'PASS' };
    },
  });
  return performance.now() - start;
}

async function main(): Promise<void> {
  const serialMs = await run(1);
  const cap4Ms = await run(4);
  const sequentialSum = CI_GATES.reduce((total, [, , ms]) => total + ms, 0);
  const speedup = serialMs / cap4Ms;
  const summary = {
    profile: 'ci',
    gate_count: CI_GATES.length,
    sequential_sum_ms: sequentialSum,
    serial_wall_ms: Math.round(serialMs),
    concurrent_cap4_wall_ms: Math.round(cap4Ms),
    speedup_x: Number(speedup.toFixed(2)),
    wall_reduction_pct: Number((100 * (1 - cap4Ms / serialMs)).toFixed(1)),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
