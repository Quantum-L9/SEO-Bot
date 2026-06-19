/* L9_META
 * layer: test
 * role: seo_bot_engine
 * status: active
 */

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import registerClientRoutes from '../../src/api/clients/register.js';

const mockDb = vi.hoisted(() => ({
  insert: vi.fn(),
}));

const mockSchema = vi.hoisted(() => ({
  clients: {
    domain: 'domain',
  },
}));

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => mockDb,
  schema: mockSchema,
}));

const validPayload = {
  schema_version: '2.0',
  domain: 'example.com',
  name: 'Example Co',
  industry: 'roofing',
  targetKeywords: [{ keyword: 'roof repair', priority: 'high' }],
  competitorUrls: ['https://competitor.example.com'],
  vercelUrl: 'https://example.vercel.app',
};

function setupDbSuccess(clientId: string) {
  const returning = vi.fn().mockResolvedValue([{ id: clientId }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  mockDb.insert.mockReturnValue({ values });
}

async function createApp() {
  const app = Fastify();
  await app.register(registerClientRoutes);
  await app.ready();
  return app;
}

describe('POST /api/clients/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 for a valid v2.0 payload', async () => {
    setupDbSuccess('client-1');
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ registered: true, clientId: 'client-1' });
    await app.close();
  });

  it('returns 400 when domain is missing', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: {
        ...validPayload,
        domain: undefined,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().registered).toBe(false);
    await app.close();
  });

  it('returns 400 when targetKeywords is missing', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: {
        ...validPayload,
        targetKeywords: undefined,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().registered).toBe(false);
    await app.close();
  });

  it('returns 400 when schema_version is not 2.0', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: {
        ...validPayload,
        schema_version: '1.0',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().registered).toBe(false);
    await app.close();
  });

  it('returns the expected success response shape', async () => {
    setupDbSuccess('client-shape');
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/clients/register',
      payload: validPayload,
    });

    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({ registered: true, clientId: 'client-shape' });
    expect(Object.keys(body).sort()).toEqual(['clientId', 'registered']);
    await app.close();
  });
});
