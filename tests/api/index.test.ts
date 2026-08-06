/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

/**
 * GAP-007 & GAP-010 — client API projection + manual-trigger routing.
 *
 * GAP-007: /api/clients and /api/clients/:id serve an EXPLICIT column allowlist
 * that excludes posthogApiKey / posthogProjectId. Nothing tested that; changing
 * `db.select(publicClientColumns)` to `db.select()` would leak both secrets. The
 * real, mock-independent guarantee is the column set passed to `select()`, so we
 * assert that.
 *
 * GAP-010: /api/clients/:id/trigger enforces a module allowlist, loads the named
 * client, and queues the job with that client's id/domain/config. Untested, so a
 * dropped clientConfig, wrong module, or weakened allowlist would ship green.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Shared, per-test queue of DB results + a record of every select() column arg.
const dbState = vi.hoisted(() => ({ queue: [] as unknown[], selectArgs: [] as unknown[] }));

vi.mock('../../src/core/database/index.js', () => {
  const makeBuilder = (result: unknown) => {
    const p = Promise.resolve(result);
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) builder[m] = () => builder;
    builder.then = (res: any, rej: any) => p.then(res, rej);
    return builder;
  };
  const db = {
    select: (cols?: unknown) => { dbState.selectArgs.push(cols); return makeBuilder(dbState.queue.shift() ?? []); },
    execute: () => Promise.resolve([]),
  };
  return {
    getDb: () => db,
    // Distinct column handles so publicClientColumns is a real, inspectable object.
    schema: {
      clients: Object.fromEntries(
        ['id', 'name', 'domain', 'industry', 'city', 'state', 'country', 'config', 'active', 'createdAt', 'updatedAt', 'posthogApiKey', 'posthogProjectId']
          .map(k => [k, `clients.${k}`]),
      ),
      serpRankings: {}, webVitals: {}, pageEngagement: {}, linkProspects: {}, aeoCitations: {}, actionOutcomes: {},
    },
  };
});

const addJobMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../src/core/scheduler.js', () => ({
  getScheduler: () => ({ addJob: addJobMock, isRunning: () => true }),
}));
vi.mock('../../src/services/llm.js', () => ({
  getLlmService: () => ({ getDailySpend: vi.fn().mockResolvedValue(0), initClient: vi.fn() }),
}));
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({ TRUST_PROXY: false, OPERATOR_API_KEY: 'op-key', DASHBOARD_ALLOWED_ORIGINS: undefined }),
}));

import { buildApiServer } from '../../src/api/index.js';

const AUTH = { authorization: 'Bearer op-key' };
const PUBLIC_COLS = ['id', 'name', 'domain', 'industry', 'city', 'state', 'country', 'config', 'active', 'createdAt', 'updatedAt'];

let app: FastifyInstance;
beforeEach(async () => {
  dbState.queue = [];
  dbState.selectArgs = [];
  addJobMock.mockClear();
  app = await buildApiServer();
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('GAP-007 — client API never projects PostHog secret columns', () => {
  it('/api/clients selects the public allowlist, excluding posthog secrets', async () => {
    dbState.queue = [[{ id: 'c1', name: 'Acme', domain: 'acme.com', industry: 'roofing' }]];

    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: AUTH });
    expect(res.statusCode).toBe(200);

    // The real guarantee: select() was handed the explicit column allowlist.
    const cols = dbState.selectArgs[0] as Record<string, unknown> | undefined;
    expect(cols).toBeDefined();                       // a bare select() (leak) would be undefined
    const keys = Object.keys(cols!);
    for (const c of PUBLIC_COLS) expect(keys).toContain(c);
    expect(keys).not.toContain('posthogApiKey');
    expect(keys).not.toContain('posthogProjectId');

    // Serialized body carries neither secret field name.
    expect(res.body).not.toContain('posthogApiKey');
    expect(res.body).not.toContain('posthogProjectId');
  });

  it('/api/clients/:id selects the same public allowlist for the client row', async () => {
    dbState.queue = [
      [{ id: 'c1', name: 'Acme', domain: 'acme.com', industry: 'roofing' }], // client
      [], [], [], [], [], // rankings, vitals, engagement, prospects, citations
    ];

    const res = await app.inject({ method: 'GET', url: '/api/clients/c1', headers: AUTH });
    expect(res.statusCode).toBe(200);

    const cols = dbState.selectArgs[0] as Record<string, unknown> | undefined;
    expect(cols).toBeDefined();
    const keys = Object.keys(cols!);
    expect(keys).not.toContain('posthogApiKey');
    expect(keys).not.toContain('posthogProjectId');
    for (const c of PUBLIC_COLS) expect(keys).toContain(c);
  });
});

describe('GAP-010 — manual-trigger routing, allowlist, and tenant payload', () => {
  const validClient = { id: 'c1', domain: 'acme.com', config: { tenant: 'A', secretish: 'x' } };

  it('queues the exact module with the loaded client id/domain/config', async () => {
    dbState.queue = [[validClient]];
    const res = await app.inject({
      method: 'POST', url: '/api/clients/c1/trigger', headers: AUTH,
      payload: { module: 'serp:check-rankings' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(addJobMock).toHaveBeenCalledTimes(1);
    expect(addJobMock).toHaveBeenCalledWith('serp:check-rankings', {
      clientId: 'c1',
      clientDomain: 'acme.com',
      clientConfig: { tenant: 'A', secretish: 'x' }, // from the DB row, not the request
    });
  });

  it('rejects a module outside the allowlist and queues nothing', async () => {
    dbState.queue = [[validClient]];
    const res = await app.inject({
      method: 'POST', url: '/api/clients/c1/trigger', headers: AUTH,
      payload: { module: 'rm:danger' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toContain('Invalid module');
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('does not queue when the client does not exist', async () => {
    dbState.queue = [[]]; // no client row
    const res = await app.inject({
      method: 'POST', url: '/api/clients/missing/trigger', headers: AUTH,
      payload: { module: 'serp:check-rankings' },
    });
    expect(res.json()).toEqual({ error: 'Client not found' });
    expect(addJobMock).not.toHaveBeenCalled();
  });

  it('still enforces operator auth on the trigger route (401 without a token)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/clients/c1/trigger',
      payload: { module: 'serp:check-rankings' },
    });
    expect(res.statusCode).toBe(401);
    expect(addJobMock).not.toHaveBeenCalled();
  });
});
