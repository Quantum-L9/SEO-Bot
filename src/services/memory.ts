/* L9_META
 * layer: service
 * role: governed_memory_adapter
 * status: active
 * version: 1.0.0
 */
import {
  GraphitiMemoryClient,
  renderHydration,
  type MemoryClass,
} from '@quantum-l9/graphiti-memory-client';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getConfig } from '../core/config.js';
import { getDb, schema } from '../core/database/index.js';
import { createModuleLogger } from '../core/logger.js';
import type { Scheduler } from '../core/scheduler.js';

const logger = createModuleLogger('service:memory');
let client: GraphitiMemoryClient | null | undefined;

type MemoryMode = 'disabled' | 'optional' | 'required';

function getMemoryClient(): GraphitiMemoryClient | null {
  if (client !== undefined) return client;
  const config = getConfig();
  const mode = config.L9_MEMORY_MODE as MemoryMode;
  if (mode === 'disabled') return (client = null);
  if (!config.L9_MEMORY_URL || !config.L9_MEMORY_TOKEN) {
    if (mode === 'required') throw new Error('L9_MEMORY_URL and L9_MEMORY_TOKEN are required');
    logger.warn('Governed memory is not configured; continuing without cross-agent hydration');
    return (client = null);
  }
  client = new GraphitiMemoryClient({ baseUrl: config.L9_MEMORY_URL, bearerToken: config.L9_MEMORY_TOKEN });
  return client;
}


async function canonicalClientId(databaseClientId: string): Promise<string> {
  // Callers pass either the DB uuid (registered clients) or the canonical string id
  // (build-time intelligence calls, which happen before registration). clients.id
  // is a uuid, so comparing it to a canonical string raises a Postgres uuid parse
  // error; resolve via the canonical id in config JSON and fall back to the input
  // for unregistered clients instead of failing the whole LLM call.
  const canonical = databaseClientId?.trim();
  if (!canonical) return databaseClientId;
  try {
    const [clientRow] = await getDb().select({ config: schema.clients.config })
      .from(schema.clients)
      .where(
        or(
          // Cast the column (not the input): comparing the uuid column directly to a
          // non-uuid string raises "invalid input syntax for type uuid" at parse time.
          sql`${schema.clients.id}::text = ${canonical}`,
          sql`${schema.clients.config}->>'canonicalClientId' = ${canonical}`,
        ),
      )
      .limit(1);
    const config = clientRow?.config as { canonicalClientId?: unknown } | undefined;
    return typeof config?.canonicalClientId === 'string' && config.canonicalClientId.trim()
      ? config.canonicalClientId.trim()
      : databaseClientId;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), input: databaseClientId },
      'canonical client id lookup failed; falling back to input id',
    );
    return databaseClientId;
  }
}

async function guarded<T>(operation: string, fn: (memory: GraphitiMemoryClient) => Promise<T>): Promise<T | undefined> {
  const memory = getMemoryClient();
  if (!memory) return undefined;
  try {
    return await fn(memory);
  } catch (error) {
    if (getConfig().L9_MEMORY_MODE === 'required') throw error;
    logger.warn({ operation, error: error instanceof Error ? error.message : String(error) }, 'Governed memory operation failed');
    return undefined;
  }
}

export async function hydrateSeoContext(
  clientId: string,
  taskType: string,
  task: string,
  topics: string[] = [],
  memoryClasses?: MemoryClass[],
): Promise<string> {
  const config = getConfig();
  const memoryClientId = await canonicalClientId(clientId);
  const result = await guarded('hydrate', memory => memory.hydrate({
    clientId: memoryClientId,
    taskType,
    task,
    topics,
    memoryClasses,
    tokenBudget: config.L9_MEMORY_TOKEN_BUDGET,
    maxRecords: config.L9_MEMORY_MAX_RECORDS,
  }));
  return result ? renderHydration(result) : '';
}

export async function promoteMeasuredOutcomes(): Promise<{ recorded: number; promoted: number; failed: number }> {
  const memory = getMemoryClient();
  if (!memory) return { recorded: 0, promoted: 0, failed: 0 };
  const db = getDb();
  // Include unpromoted rows that already have a memory receipt so a transient
  // promotion failure does not strand them forever. Idempotency makes record
  // creation safe to retry when the receipt pointer was not persisted.
  const outcomes = await db.select()
    .from(schema.actionOutcomes)
    .where(and(
      eq(schema.actionOutcomes.success, true),
      isNotNull(schema.actionOutcomes.measuredAt),
      isNotNull(schema.actionOutcomes.learnings),
      isNull(schema.actionOutcomes.memoryPromotedAt),
    ));

  let recorded = 0;
  let promoted = 0;
  let failed = 0;
  const candidates: Array<{ outcome: typeof outcomes[number]; clientId: string; recordId: string; signature: string }> = [];

  for (const outcome of outcomes) {
    try {
      const memoryClientId = await canonicalClientId(outcome.clientId);
      let recordId = outcome.memoryRecordId;
      if (!recordId) {
        const receipt = await memory.writeOutcome({
          clientId: memoryClientId,
          sourceId: `seo-outcome:${outcome.id}`,
          idempotencyKey: `seo-outcome:${outcome.id}`,
          content: JSON.stringify({
            kind: 'measured_seo_outcome',
            module: outcome.module,
            action: outcome.action,
            executed_at: outcome.executedAt,
            measured_at: outcome.measuredAt,
            position_before: outcome.positionBefore,
            position_after: outcome.positionAfter,
            traffic_before: outcome.trafficBefore,
            traffic_after: outcome.trafficAfter,
            success: outcome.success,
            learnings: outcome.learnings,
          }),
          subject: memoryClientId,
          predicate: `seo_outcome:${outcome.action}`,
          object: String(outcome.learnings),
          tags: ['seo-bot', 'measured-outcome', outcome.module, outcome.action],
        });
        if (!receipt.record_id) throw new Error(`Memory write ${receipt.status} returned no record_id`);
        recordId = receipt.record_id;
        await db.update(schema.actionOutcomes)
          .set({ memoryRecordId: recordId, memoryPromotionError: null })
          .where(eq(schema.actionOutcomes.id, outcome.id));
        recorded += 1;
      }
      const signature = JSON.stringify([memoryClientId, outcome.module, outcome.action, String(outcome.learnings).trim()]);
      candidates.push({ outcome, clientId: memoryClientId, recordId, signature });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(schema.actionOutcomes)
        .set({ memoryPromotionError: message.slice(0, 2_000) })
        .where(eq(schema.actionOutcomes.id, outcome.id));
      logger.warn({ outcomeId: outcome.id, error: message }, 'Measured outcome memory recording failed');
      failed += 1;
    }
  }

  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.signature) ?? [];
    group.push(candidate);
    groups.set(candidate.signature, group);
  }

  for (const group of groups.values()) {
    // Promotion is evidence-bound: one observation is recorded but never
    // described as corroborated. Two independently measured matching outcomes
    // are the minimum support for an insight candidate.
    if (group.length < 2) continue;
    const [target, ...support] = group;
    if (!target) continue;
    try {
      await memory.promoteLearning({
        recordId: target.recordId,
        targetClass: 'insight',
        reason: `Promote corroborated measured SEO outcome supported by ${group.length} matching measurements`,
        supportingRecordIds: support.map(item => item.recordId),
        testSuccessCount: group.length,
        explicitConfirmation: false,
      });
      const promotedAt = new Date();
      for (const item of group) {
        await db.update(schema.actionOutcomes)
          .set({ memoryPromotedAt: promotedAt, memoryPromotionError: null })
          .where(eq(schema.actionOutcomes.id, item.outcome.id));
      }
      promoted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of group) {
        await db.update(schema.actionOutcomes)
          .set({ memoryPromotionError: message.slice(0, 2_000) })
          .where(eq(schema.actionOutcomes.id, item.outcome.id));
      }
      logger.warn({ outcomeIds: group.map(item => item.outcome.id), error: message }, 'Corroborated memory promotion failed');
      failed += group.length;
    }
  }
  return { recorded, promoted, failed };
}

export function registerMemoryHandlers(scheduler: Scheduler): void {
  scheduler.registerDefinition({
    name: 'memory:promote-measured-outcomes',
    module: 'memory',
    cron: '30 2 * * *',
    handler: 'promoteMeasuredOutcomes',
    clientScoped: false,
    tokenBudget: { maxFastTokensPerRun: 0, maxStrategicTokensPerRun: 0, cooldownMinutes: 0 },
    enabled: true,
  });
  scheduler.registerHandler('memory:promote-measured-outcomes', async () => {
    const result = await promoteMeasuredOutcomes();
    logger.info(result, 'Measured outcome memory promotion completed');
  });
}
