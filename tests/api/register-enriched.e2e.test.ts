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
import { digestContractPayload, WebsiteFactoryContractV2 } from '../../src/contracts/website_factory_v2.js';

const KEY = 'registration-key';
const AUTH = { authorization: `Bearer ${KEY}` };
const commit = 'a'.repeat(40);
const sourceDigest = 'b'.repeat(64);

function enrichedPayload() {
  const base = {
    schema_version: '2.0' as const,
    domain: 'https://www.Client.example.com/',
    name: 'Client',
    industry: 'services',
    state: 'NC',
    targetKeywords: [{ keyword: 'service nc', priority: 'high' as const }],
    competitorUrls: [] as string[],
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
  const contract = WebsiteFactoryContractV2.parse(base);
  return { ...contract, integrity: { algorithm: 'sha256' as const, payload_digest: digestContractPayload(contract) } };
}

function githubFetch(options: { repoStatus?: number } = {}): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.endsWith('/repos/Quantum-L9/client-site')) return Response.json({ id: 123, full_name: 'Quantum-L9/client-site' }, { status: options.repoStatus ?? 200 });
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: commit } });
    if (url.includes('/contents/')) return Response.json({ sha: 'file-sha' });
    return Response.json({}, { status: 500 });
  };
}

let app: FastifyInstance;
async function build(fetchImpl: typeof fetch) {
  app = Fastify();
  await registerClientRoutes(app, {
    fetchImpl,
    env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: 'token' } as NodeJS.ProcessEnv,
    now: () => new Date('2026-07-20T12:01:00.000Z'),
  });
  await app.ready();
}

beforeEach(() => {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: 'client-uuid-1' }]);
});
afterEach(async () => { await app?.close(); });

describe('POST /api/clients/register — enriched v2 (verified maintenance)', () => {
  it('activates maintenance when GitHub readiness passes (201)', async () => {
    await build(githubFetch());
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: enrichedPayload(), headers: AUTH });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.maintenance_ready).toBe(true);
    expect(body.verified_commit_sha).toBe(commit);
    const inserted = valuesMock.mock.calls[0][0] as any;
    expect(inserted.active).toBe(true);
    expect(inserted.config.site_deployment.status).toBe('ready');
    expect(inserted.config.site_deployment.schemaVersion).toBe('2.0');
    expect(inserted.domain).toBe('client.example.com');
  });

  it('registers inactive when GitHub readiness fails (202, fail-closed)', async () => {
    await build(githubFetch({ repoStatus: 404 }));
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: enrichedPayload(), headers: AUTH });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.maintenance_ready).toBe(false);
    expect(body.error).toBe('REPOSITORY_NOT_FOUND');
    const inserted = valuesMock.mock.calls[0][0] as any;
    expect(inserted.active).toBe(false);
  });

  it('rejects a tampered integrity digest (400) without touching the DB', async () => {
    await build(githubFetch());
    const tampered = { ...enrichedPayload(), name: 'Renamed Co' };
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: tampered, headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('integrity_digest_mismatch');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('never responds with canonical_v3_handoff_required', async () => {
    await build(githubFetch());
    const res = await app.inject({ method: 'POST', url: '/api/clients/register', payload: enrichedPayload(), headers: AUTH });
    expect(JSON.stringify(res.json())).not.toContain('canonical_v3');
  });
});
