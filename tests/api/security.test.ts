import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// Live-mutable config so tests can flip OPERATOR_API_KEY at request time.
const cfg = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../../src/core/config.js', () => ({ getConfig: () => cfg.current }));
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  parseAuthSecret,
  constantTimeEqual,
  isStrictRateLimited,
  registerApiSecurity,
  _resetRateLimiter,
} from '../../src/api/security.js';

describe('parseAuthSecret', () => {
  it('parses a Bearer token', () => {
    expect(parseAuthSecret('Bearer abc123')).toBe('abc123');
  });
  it('parses the password portion of Basic auth', () => {
    const b64 = Buffer.from('operator:s3cret').toString('base64');
    expect(parseAuthSecret(`Basic ${b64}`)).toBe('s3cret');
  });
  it('returns null for missing or unsupported schemes', () => {
    expect(parseAuthSecret(undefined)).toBeNull();
    expect(parseAuthSecret('Weird xyz')).toBeNull();
    expect(parseAuthSecret('Bearer ')).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('isStrictRateLimited', () => {
  it('flags the expensive/abusable routes', () => {
    expect(isStrictRateLimited('/api/clients/register')).toBe(true);
    expect(isStrictRateLimited('/api/clients/abc-123/trigger')).toBe(true);
  });
  it('does not flag ordinary reads', () => {
    expect(isStrictRateLimited('/api/clients')).toBe(false);
    expect(isStrictRateLimited('/dashboard')).toBe(false);
  });
});

describe('operator auth hook', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetRateLimiter();
    cfg.current = { OPERATOR_API_KEY: 'topsecret' };
    app = Fastify();
    registerApiSecurity(app);
    app.get('/health', async () => ({ ok: true }));
    app.get('/api/clients', async () => ({ clients: [] }));
    await app.ready();
  });

  it('allows /health without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a protected route with 401 and a WWW-Authenticate challenge', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain('Basic');
  });

  it('accepts a correct Bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: { authorization: 'Bearer topsecret' } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a correct Basic password', async () => {
    const b64 = Buffer.from('operator:topsecret').toString('base64');
    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: { authorization: `Basic ${b64}` } });
    expect(res.statusCode).toBe(200);
  });

  it('fails closed (401) when OPERATOR_API_KEY is unset', async () => {
    cfg.current = {};
    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: { authorization: 'Bearer anything' } });
    expect(res.statusCode).toBe(401);
  });
});
