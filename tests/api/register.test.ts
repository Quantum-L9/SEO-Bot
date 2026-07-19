import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// Chainable Drizzle mock: insert().values().onConflictDoUpdate().returning()
const { insertMock, valuesMock, onConflictDoUpdateMock, returningMock } = vi.hoisted(() => {
  const returningMock = vi.fn();
  const onConflictDoUpdateMock = vi.fn(() => ({ returning: returningMock }));
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  return { insertMock, valuesMock, onConflictDoUpdateMock, returningMock };
});

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { clients: { domain: 'clients.domain', id: 'clients.id' } },
}));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { registerClientRoutes } from '../../src/api/clients/register.js';

const KEY = 'super-secret-key';
const AUTH = { authorization: `Bearer ${KEY}` };

const basePayload = {
  schema_version: '2.0',
  domain: 'https://www.Example.com/',
  name: 'Example Co',
  industry: 'roofing',
  targetKeywords: [{ keyword: 'roof repair', priority: 'high' }],
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: 'client-uuid-1' }]);
  // Registration is now fail-closed: a key MUST be configured. The happy-path
  // tests below therefore run with the key set and present a valid bearer.
  process.env.SEO_BOT_API_KEY = KEY;
  app = Fastify();
  await registerClientRoutes(app);
  await app.ready();
});

afterEach(() => {
  delete process.env.SEO_BOT_API_KEY;
});

describe('POST /api/clients/register', () => {
  it('registers a valid v2 payload, normalizes the domain, and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: basePayload, headers: AUTH });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ registered: true, clientId: 'client-uuid-1' });
    expect(insertMock).toHaveBeenCalledOnce();

    const inserted = valuesMock.mock.calls[0][0] as any;
    expect(inserted.domain).toBe('example.com');
    expect(inserted.config.targetKeywords).toEqual(basePayload.targetKeywords);
    expect(inserted.config.competitorUrls).toEqual([]);
    // Upsert is keyed on the unique domain so re-deploys refresh, not 500.
    expect(onConflictDoUpdateMock).toHaveBeenCalledOnce();
  });

  it('rejects a missing domain with 400', async () => {
    const { domain, ...rest } = basePayload;
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: rest, headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().registered).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects missing targetKeywords with 400', async () => {
    const { targetKeywords, ...rest } = basePayload;
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: rest, headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it('rejects the wrong schema_version with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: { ...basePayload, schema_version: '1.0' },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the DB write throws', async () => {
    returningMock.mockRejectedValueOnce(new Error('unique constraint violation'));
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: basePayload, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().registered).toBe(false);
  });
});

describe('POST /api/clients/register — API key gate (fail closed)', () => {
  it('rejects with 401 when a key is configured but no Authorization header is sent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: basePayload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ registered: false, error: 'unauthorized' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 on a wrong bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: basePayload,
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correct bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: basePayload,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ registered: true, clientId: 'client-uuid-1' });
  });

  it('rejects with 503 when no key is configured (fail closed, no anonymous upserts)', async () => {
    delete process.env.SEO_BOT_API_KEY;
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: basePayload, headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json().registered).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
