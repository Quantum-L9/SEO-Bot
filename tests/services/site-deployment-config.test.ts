import { describe, expect, it } from 'vitest';
import { siteConfigFromStoredClient } from '../../src/services/site-deployment-config.js';

const canonical = {
  site_deployment: {
    schemaVersion: '2.0',
    status: 'ready',
    githubCredentialRef: 'env://TENANT_GITHUB_TOKEN',
    vercelDeployHookRef: 'env://TENANT_DEPLOY_HOOK',
    websiteBotRepo: 'Quantum-L9/client-site',
    sourceBranch: 'main',
    verifiedCommitSha: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64),
    contractId: 'client:build:' + 'a'.repeat(40),
    contractDigest: 'c'.repeat(64),
    verifiedAt: '2026-07-20T12:01:00.000Z',
    managedManifestPath: '.l9/generated-manifest.json',
    editableRoot: 'src/pages',
    pagePathStrategy: 'directory-index-astro',
  },
};

describe('siteConfigFromStoredClient', () => {
  it('resolves secret references without persisting raw secrets', () => {
    const config = siteConfigFromStoredClient(canonical, {
      TENANT_GITHUB_TOKEN: 'gh-token',
      TENANT_DEPLOY_HOOK: 'https://api.vercel.com/hook',
    });
    expect(config).toEqual({
      githubToken: 'gh-token',
      vercelDeployHook: 'https://api.vercel.com/hook',
      websiteBotRepo: 'Quantum-L9/client-site',
      sourceBranch: 'main',
      dryRun: false,
    });
  });

  it('fails closed when the schemaVersion is not the canonical v2 marker', () => {
    const config = siteConfigFromStoredClient(
      { site_deployment: { ...canonical.site_deployment, schemaVersion: '1.0' } },
      { TENANT_GITHUB_TOKEN: 'gh-token', TENANT_DEPLOY_HOOK: 'https://api.vercel.com/hook' },
    );
    expect(config.dryRun).toBe(true);
  });

  it('fails closed when the repository contract is incomplete', () => {
    const config = siteConfigFromStoredClient(
      { site_deployment: { ...canonical.site_deployment, verifiedCommitSha: undefined } },
      { TENANT_GITHUB_TOKEN: 'gh-token' },
    );
    expect(config.dryRun).toBe(true);
  });

  it('fails closed when verification evidence is structurally incomplete', () => {
    const config = siteConfigFromStoredClient(
      { site_deployment: { ...canonical.site_deployment, contractDigest: undefined } },
      { TENANT_GITHUB_TOKEN: 'gh-token' },
    );
    expect(config.dryRun).toBe(true);
  });

  it('fails closed when a credential reference is unresolved', () => {
    const config = siteConfigFromStoredClient(canonical, {});
    expect(config.dryRun).toBe(true);
  });
});
