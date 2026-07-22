// L9_META: layer=source, role=tracked_file, status=active, version=1.0.0
import { describe, expect, it } from 'vitest';
import { digestHandoffPayload, type WebsiteFactoryHandoffV3 } from '../../src/contracts/website_factory_v3.js';
import { MaintenanceReadinessError, verifyMaintenanceReadiness } from '../../src/services/maintenance-readiness.js';

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
        provider: 'github' as const,
        full_name: 'Quantum-L9/client-site',
        repository_id: '123',
        branch: 'main',
        commit_sha: commit,
        source_digest: sourceDigest,
        managed_manifest_path: '.l9/generated-manifest.json' as const,
        editable_root: 'src/pages' as const,
        page_path_strategy: 'directory-index-astro' as const,
      },
      deployment: {
        provider: 'vercel' as const,
        project_id: 'prj_1', deployment_id: 'dpl_1', deployment_url: 'https://client.example.com',
        state: 'READY' as const, requested_commit_sha: commit, observed_commit_sha: commit,
      },
      maintenance: {
        enabled: true as const, transport: 'github-contents-api' as const,
        github_credential_ref: 'env://CLIENT_GITHUB_TOKEN',
        vercel_deploy_hook_ref: 'env://CLIENT_VERCEL_HOOK',
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

function githubFetch(options: { repoStatus?: number; head?: string; missingPath?: string } = {}): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.endsWith('/repos/Quantum-L9/client-site')) {
      return Response.json({ id: 123, full_name: 'Quantum-L9/client-site' }, { status: options.repoStatus ?? 200 });
    }
    if (url.includes('/git/ref/heads/main')) return Response.json({ object: { sha: options.head ?? commit } });
    if (options.missingPath && url.includes(options.missingPath)) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (url.includes('/contents/')) return Response.json({ sha: 'file-sha' });
    return Response.json({ message: 'unexpected' }, { status: 500 });
  };
}

describe('verifyMaintenanceReadiness', () => {
  it('proves repository, branch, manifest, editable page, and secret refs', async () => {
    const result = await verifyMaintenanceReadiness(contract(), {
      fetchImpl: githubFetch(),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
      now: () => new Date('2026-07-20T12:01:00.000Z'),
    });
    expect(result.ready).toBe(true);
    expect(result.verifiedCommitSha).toBe(commit);
    expect(result.probes.every(probe => probe.ok)).toBe(true);
  });

  it('rejects a nonexistent repository before persistence', async () => {
    await expect(verifyMaintenanceReadiness(contract(), {
      fetchImpl: githubFetch({ repoStatus: 404 }),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
    })).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
  });


  it('rejects a repository id mismatch even when owner/name resolves', async () => {
    const payload = contract();
    payload.site.repository.repository_id = '999';
    const withoutIntegrity = (({ integrity: _integrity, ...rest }) => rest)(payload);
    payload.integrity.payload_digest = digestHandoffPayload(withoutIntegrity);
    await expect(verifyMaintenanceReadiness(payload, {
      fetchImpl: githubFetch(),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
    })).rejects.toMatchObject({ code: 'REPOSITORY_ID_MISMATCH' });
  });

  it('rejects branch drift from the deployed commit', async () => {
    await expect(verifyMaintenanceReadiness(contract(), {
      fetchImpl: githubFetch({ head: 'd'.repeat(40) }),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
    })).rejects.toMatchObject({ code: 'COMMIT_MISMATCH' });
  });


  it('probes every declared required path, not only the two canonical anchors', async () => {
    const payload = contract();
    payload.site.maintenance.required_paths.push('src/pages/services/index.astro');
    const withoutIntegrity = (({ integrity: _integrity, ...rest }) => rest)(payload);
    payload.integrity.payload_digest = digestHandoffPayload(withoutIntegrity);
    await expect(verifyMaintenanceReadiness(payload, {
      fetchImpl: githubFetch({ missingPath: 'src/pages/services/index.astro' }),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
    })).rejects.toMatchObject({ code: 'REQUIRED_PATH_MISSING' });
  });

  it('rejects a missing editable Astro page', async () => {
    await expect(verifyMaintenanceReadiness(contract(), {
      fetchImpl: githubFetch({ missingPath: 'src/pages/index.astro' }),
      env: { CLIENT_GITHUB_TOKEN: 'token', CLIENT_VERCEL_HOOK: 'https://hook.example.com' },
    })).rejects.toMatchObject({ code: 'REQUIRED_PATH_MISSING' });
  });
});
