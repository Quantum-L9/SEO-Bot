// L9_META: layer=source, role=tracked_file, status=active, version=1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { insertMock, valuesMock, onConflictDoUpdateMock, returningMock } = vi.hoisted(() => {
  const returningMock = vi.fn();
  const onConflictDoUpdateMock = vi.fn(() => ({ returning: returningMock }));
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  return { insertMock, valuesMock, onConflictDoUpdateMock, returningMock };
});

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { clients: { domain: 'clients.domain' } },
}));
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerClientRoutes } from '../../src/api/clients/register.js';
import { digestHandoffPayload, type WebsiteFactoryHandoffV3 } from '../../src/contracts/website_factory_v3.js';

const KEY = 'registration-key';
const commit = 'a'.repeat(40);
const sourceDigest = 'b'.repeat(64);

function contract(): WebsiteFactoryHandoffV3 {
  const payload = {
    protocol: 'l9.website-factory.handoff' as const,
    schema_version: '3.0' as const,
    contract_id: `client:build:${commit}`,
    emitted_at: '2026-07-20T12:00:00.000Z',
    client: { id: 'client', domain: 'client.example.com', name: 'Client', industry: 'services', state: 'NC' },
    seo: { target_keywords: [{ keyword: 'service nc', priority: 'high' as const }], competitor_urls: [] },
    site: {
      repository: {
        provider: 'github' as const, full_name: 'Quantum-L9/client-site', repository_id: '123', branch: 'main',
        commit_sha: commit, source_digest: sourceDigest, managed_manifest_path: '.l9/generated-manifest.json' as const,
        editable_root: 'src/pages' as const, page_path_strategy: 'directory-index-astro' as const,
      },
      deployment: {
        provider: 'vercel' as const, project_id: 'prj_1', deployment_id: 'dpl_1',
        deployment_url: 'https://client.example.com', state: 'READY' as const,
        requested_commit_sha: commit, observed_commit_sha: commit,
      },
      maintenance: {
        enabled: true as const, transport: 'github-contents-api' as const,
        github_credential_ref: 'env://CLIENT_GITHUB_TOKEN',
        required_paths: ['.l9/generated-manifest.json', 'src/pages/index.astro'],
      },
    },
    proof: {
      receipt_id: 'rcpt_1', receipt_status: 'succeeded' as const, source_digest: sourceDigest,
      dist_digest: 'c'.repeat(64), local_build_status: 'passed' as const,
      publication_status: 'passed' as const, deployment_status: 'passed' as const,
    },
  };
  return { ...payload, integrity: { algorithm: 'sha256', payload_digest: digestHandoffPayload(payload) } };
}

function githubFetch(options: { repoStatus?: number; head?: string } = {}): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.endsWith('/repos/Quantum-L9/client-site')) return Response.json({ id: 123, full_name: 'Quantum-L9/client-site' }, { status: options.repoStatus ?? 200 });
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: options.head ?? commit } });
    if (url.includes('/contents/')) return Response.json({ sha: 'file-sha' });
    return Response.json({}, { status: 500 });
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: 'client-db-id' }]);
  app = Fastify();
  await registerClientRoutes(app, {
    fetchImpl: githubFetch(),
    env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: 'token' },
    now: () => new Date('2026-07-20T12:01:00.000Z'),
  });
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe('canonical Website-Bot -> SEO-Bot registration', () => {
  it('activates a client only after maintenance readiness is proven', async () => {
    const payload = contract();
    const response = await app.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      registered: true, maintenance_ready: true, client_id: 'client',
      contract_id: payload.contract_id, contract_digest: payload.integrity.payload_digest,
      verified_commit_sha: commit,
    });
    const inserted = ((valuesMock.mock.calls as unknown as Array<[Record<string, any>]>)[0]?.[0]);
    expect(inserted).toBeDefined();
    expect(inserted.active).toBe(true);
    expect(inserted.config.site_deployment).toMatchObject({
      schemaVersion: '3.0', status: 'ready', websiteBotRepo: 'Quantum-L9/client-site',
      githubCredentialRef: 'env://CLIENT_GITHUB_TOKEN', verifiedCommitSha: commit,
    });
    expect(JSON.stringify(inserted.config)).not.toContain('token');
  });

  it('rejects a dead repository and performs no DB write', async () => {
    const dead = Fastify();
    await registerClientRoutes(dead, {
      fetchImpl: githubFetch({ repoStatus: 404 }),
      env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: 'token' },
    });
    await dead.ready();
    const payload = contract();
    const response = await dead.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ registered: false, maintenance_ready: false, error: 'REPOSITORY_NOT_FOUND' });
    expect(insertMock).not.toHaveBeenCalled();
    await dead.close();
  });

  it('rejects commit drift and performs no DB write', async () => {
    const drifted = Fastify();
    await registerClientRoutes(drifted, {
      fetchImpl: githubFetch({ head: 'd'.repeat(40) }),
      env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: 'token' },
    });
    await drifted.ready();
    const payload = contract();
    const response = await drifted.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('COMMIT_MISMATCH');
    expect(insertMock).not.toHaveBeenCalled();
    await drifted.close();
  });


  it('rejects an idempotency key that does not identify the emitted contract', async () => {
    const payload = contract();
    const response = await app.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'different-contract' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('idempotency_key_mismatch');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects payload tampering after the producer computed its digest', async () => {
    const payload = contract();
    payload.client.name = 'Tampered Client';
    const response = await app.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('integrity_digest_mismatch');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects an unresolved credential reference without creating an inactive half-client', async () => {
    const unresolved = Fastify();
    await registerClientRoutes(unresolved, {
      fetchImpl: githubFetch(),
      env: { SEO_BOT_API_KEY: KEY },
    });
    await unresolved.ready();
    const payload = contract();
    const response = await unresolved.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('SECRET_UNRESOLVED');
    expect(insertMock).not.toHaveBeenCalled();
    await unresolved.close();
  });

  it('rejects raw secret fields because the v3 schema is strict', async () => {
    const payload = { ...contract(), githubToken: 'must-not-cross-wire' };
    const response = await app.inject({
      method: 'POST', url: '/api/clients/register', payload,
      headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': payload.contract_id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('canonical_v3_handoff_required');
  });
});
