import os from 'node:os';

/**
 * Dependency-aware, bounded-concurrency scheduler for the validation gate DAG.
 *
 * The previous runner awaited each gate in a strict `for` loop, so gates that
 * only share an upstream dependency (e.g. `typecheck`, `lint`, `test`,
 * `manifest`, `claims` all depend only on `source`) ran one-at-a-time even
 * though they are mutually independent. This scheduler runs independent gates
 * concurrently up to a fixed cap while preserving the exact dependency and
 * dependency-blocked semantics of the serial version:
 *
 * - A gate is decided only once every dependency has a terminal result.
 * - If any dependency is not "satisfied" (PASS / PASS_WITH_FINDINGS), the gate
 *   is dependency-blocked and never executed; its own dependents cascade.
 * - Otherwise the gate executes, counting against the concurrency cap.
 *
 * Blocked decisions are resolved synchronously and never consume a slot, so a
 * blocked subtree cannot starve runnable gates. Setting the cap to 1 reproduces
 * the original serial order exactly (a built-in compatibility / rollback lever).
 */

export interface SchedulableGate {
  readonly dependencies: readonly string[];
}

export interface ScheduleHandlers<R> {
  /** Execute a gate whose dependencies are all satisfied. Must not reject. */
  runGate(gateId: string): Promise<R>;
  /** Produce the result for a gate blocked by unsatisfied dependencies. */
  onDependencyBlocked(gateId: string, failedDependencies: string[]): R;
  /** Whether a completed gate's result lets its dependents proceed. */
  isSatisfied(result: R): boolean;
  /** Maximum gates executing concurrently (>= 1). */
  concurrency: number;
}

/**
 * Resolve the gate concurrency cap: the `VALIDATION_CONCURRENCY` env override
 * when it is a positive integer, otherwise a bounded default of
 * `min(4, cpuCount)`. Never returns less than 1, so the scheduler always makes
 * progress and never spawns an unbounded number of gate subprocess trees.
 */
export function resolveGateConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VALIDATION_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const cpuCount = os.cpus?.().length ?? 1;
  return Math.max(1, Math.min(4, cpuCount));
}

/**
 * Run the gates named in `gateOrder` (which MUST be a valid topological order —
 * every dependency precedes its dependents) with bounded concurrency. Resolves
 * to a result map keyed by gate id once every gate has a terminal result. The
 * caller is responsible for consuming results in `gateOrder` so downstream
 * evidence and reporting stay deterministic regardless of completion order.
 */
export function scheduleGates<R>(
  gateOrder: readonly string[],
  gateById: ReadonlyMap<string, SchedulableGate>,
  handlers: ScheduleHandlers<R>,
): Promise<Map<string, R>> {
  const concurrency = Math.max(1, Math.floor(handlers.concurrency));
  const results = new Map<string, R>();
  const pending = new Set<string>(gateOrder);
  const inFlight = new Set<string>();

  return new Promise<Map<string, R>>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const dependenciesOf = (gateId: string): readonly string[] => {
      const gate = gateById.get(gateId);
      if (!gate) throw new Error(`Unknown gate in schedule: ${gateId}`);
      return gate.dependencies;
    };

    const pump = (): void => {
      if (settled) return;
      // Walk in gateOrder so dispatch priority is deterministic and any
      // synchronously-blocked gate is resolved before its dependents are seen.
      for (const gateId of gateOrder) {
        if (!pending.has(gateId) || inFlight.has(gateId)) continue;

        const deps = dependenciesOf(gateId);
        if (!deps.every((dep) => results.has(dep))) continue; // deps not terminal yet

        const failed = deps.filter((dep) => !handlers.isSatisfied(results.get(dep) as R));
        if (failed.length > 0) {
          results.set(gateId, handlers.onDependencyBlocked(gateId, failed));
          pending.delete(gateId);
          continue; // cascades to dependents later in this same pass
        }

        if (inFlight.size >= concurrency) continue; // saturated; try again on completion

        pending.delete(gateId);
        inFlight.add(gateId);
        Promise.resolve()
          .then(() => handlers.runGate(gateId))
          .then(
            (result) => {
              results.set(gateId, result);
              inFlight.delete(gateId);
              pump();
            },
            (error) => fail(error),
          );
      }

      if (!settled && pending.size === 0 && inFlight.size === 0) {
        settled = true;
        resolve(results);
      }
    };

    try {
      pump();
    } catch (error) {
      fail(error);
    }
  });
}
