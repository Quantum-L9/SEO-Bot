import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock axios (site-deployment uses `import axios from 'axios'`).
const { postMock, getMock, putMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  putMock: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: postMock, get: getMock, put: putMock } }));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  requestSiteBuild,
  siteConfigFromClient,
  updateMetaTitle,
  yamlDoubleQuoted,
  type SiteDeploymentConfig,
} from '../../src/services/site-deployment.js';
import type { ClientConfig } from '../../src/types/index.js';

/** A partial ClientConfig carrying only a site_deployment block — mirrors the
 *  JSONB reality where existing clients may omit it. `siteConfigFromClient`
 *  accepts `Partial<ClientConfig>`, so no cast is required. */
function clientWithDeployment(sd?: ClientConfig['site_deployment']): Partial<ClientConfig> {
  return sd ? { site_deployment: sd } : {};
}

const liveConfig: SiteDeploymentConfig = {
  githubToken: 'tok',
  vercelDeployHook: '',
  websiteBotRepo: 'Quantum-L9/Website-Bot',
  sourceBranch: 'main',
  dryRun: false,
};

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue({ data: {} });
  getMock.mockReset();
  putMock.mockReset();
});

describe('requestSiteBuild', () => {
  it('POSTs a build-site repository_dispatch with the client_payload', async () => {
    const result = await requestSiteBuild({ clientId: 'c1', specPath: 'inputs/c1.yaml' }, liveConfig);

    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body, opts] = postMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Quantum-L9/Website-Bot/dispatches');
    expect(body).toEqual({
      event_type: 'build-site',
      client_payload: { client_id: 'c1', spec_path: 'inputs/c1.yaml' },
    });
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(result).toMatchObject({ dispatched: true, dryRun: false, clientId: 'c1', specPath: 'inputs/c1.yaml' });
  });

  it('defaults spec_path to the canonical normalized spec when omitted', async () => {
    await requestSiteBuild({ clientId: 'c2' }, liveConfig);
    expect(postMock.mock.calls[0][1].client_payload.spec_path).toBe('domain_spec/domain_spec.normalized.yaml');
  });

  it('is a no-op dry-run (no axios call) when config is dry-run', async () => {
    const result = await requestSiteBuild({ clientId: 'c3' }, { ...liveConfig, dryRun: true });
    expect(postMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      dispatched: false,
      dryRun: true,
      clientId: 'c3',
      specPath: 'domain_spec/domain_spec.normalized.yaml',
    });
  });
});

describe('yamlDoubleQuoted', () => {
  it('escapes embedded double-quotes so frontmatter stays valid YAML', () => {
    expect(yamlDoubleQuoted('Best "Roofer" in Austin')).toBe('"Best \\"Roofer\\" in Austin"');
  });

  it('collapses newlines so a value cannot inject an extra frontmatter key', () => {
    expect(yamlDoubleQuoted('Title\nmalicious: true')).toBe('"Title malicious: true"');
  });

  it('escapes backslashes and tolerates empty/nullish input', () => {
    expect(yamlDoubleQuoted('a\\b')).toBe('"a\\\\b"');
    expect(yamlDoubleQuoted('')).toBe('""');
    expect(yamlDoubleQuoted(null)).toBe('""');
    expect(yamlDoubleQuoted(undefined)).toBe('""');
  });
});

describe('siteConfigFromClient — MT dry-run guard (G6)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    // Neutralize the global env kills so the config's own guard is what we test.
    delete process.env.NODE_ENV;
    delete process.env.SITE_DEPLOY_DRY_RUN;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    process.env.SITE_DEPLOY_DRY_RUN = savedEnv.SITE_DEPLOY_DRY_RUN;
  });

  it('a canonically-verified v3 site_deployment yields dryRun:false and resolves env:// credential refs', () => {
    // Since the v3 handoff became the runtime schema authority, live writes
    // (dryRun:false) require a verified canonical contract; inline secrets no
    // longer qualify. Credentials come from env:// refs resolved at use time.
    process.env.TENANT_A_GITHUB_TOKEN = 'ghp_live';
    process.env.TENANT_A_DEPLOY_HOOK = 'https://hook/a';
    try {
      const cfg = siteConfigFromClient(clientWithDeployment({
        schemaVersion: '3.0',
        status: 'ready',
        githubCredentialRef: 'env://TENANT_A_GITHUB_TOKEN',
        vercelDeployHookRef: 'env://TENANT_A_DEPLOY_HOOK',
        websiteBotRepo: 'Quantum-L9/tenant-a',
        sourceBranch: 'release',
        verifiedCommitSha: 'a'.repeat(40),
        sourceDigest: 'b'.repeat(64),
        contractId: 'contract-1',
        contractDigest: 'c'.repeat(64),
        verifiedAt: '2026-07-01T00:00:00.000Z',
        managedManifestPath: '.l9/generated-manifest.json',
        editableRoot: 'src/pages',
        pagePathStrategy: 'directory-index-astro',
      } as ClientConfig['site_deployment']));
      expect(cfg).toEqual({
        githubToken: 'ghp_live',
        websiteBotRepo: 'Quantum-L9/tenant-a',
        vercelDeployHook: 'https://hook/a',
        sourceBranch: 'release',
        dryRun: false,
      });
    } finally {
      delete process.env.TENANT_A_GITHUB_TOKEN;
      delete process.env.TENANT_A_DEPLOY_HOOK;
    }
  });

  it('legacy inline credentials stay dry-run even when present (fail closed without a v3 contract)', () => {
    const cfg = siteConfigFromClient(clientWithDeployment({
      githubToken: 'ghp_live',
      websiteBotRepo: 'Quantum-L9/tenant-a',
      vercelDeployHook: 'https://hook/a',
      sourceBranch: 'release',
    }));
    expect(cfg.dryRun).toBe(true);
  });

  it('a missing token forces dryRun:true', () => {
    const cfg = siteConfigFromClient(clientWithDeployment({
      websiteBotRepo: 'Quantum-L9/tenant-a',
      sourceBranch: 'main',
    }));
    expect(cfg.dryRun).toBe(true);
  });

  it('an EMPTY-STRING repo forces dryRun:true (blank ≠ configured)', () => {
    const cfg = siteConfigFromClient(clientWithDeployment({
      githubToken: 'ghp_live',
      websiteBotRepo: '',
      sourceBranch: 'main',
    }));
    expect(cfg.dryRun).toBe(true);
  });

  it('an absent site_deployment block forces dryRun:true', () => {
    const cfg = siteConfigFromClient(clientWithDeployment());
    expect(cfg.dryRun).toBe(true);
    expect(cfg.sourceBranch).toBe('main');
  });

  it('still honors the NODE_ENV=test global kill even with a full config', () => {
    process.env.NODE_ENV = 'test';
    const cfg = siteConfigFromClient(clientWithDeployment({
      githubToken: 'ghp_live',
      websiteBotRepo: 'Quantum-L9/tenant-a',
    }));
    expect(cfg.dryRun).toBe(true);
  });
});

describe('updateMetaTitle — explicit config overrides env', () => {
  it('reads/writes against the injected config\'s repo, not the env fallback', async () => {
    getMock.mockResolvedValue({
      data: { content: Buffer.from('title: old\n').toString('base64'), sha: 'sha-1' },
    });
    putMock.mockResolvedValue({
      data: { content: { sha: 'sha-2' }, commit: { html_url: 'https://gh/commit/2' } },
    });

    const explicit: SiteDeploymentConfig = {
      githubToken: 'ghp_explicit',
      vercelDeployHook: '',
      websiteBotRepo: 'Quantum-L9/explicit-repo',
      sourceBranch: 'main',
      dryRun: false,
    };

    await updateMetaTitle('src/pages/index.astro', 'New Title', 'tenant.com', explicit);

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0][0]).toContain('Quantum-L9/explicit-repo');
    expect(getMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_explicit');
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][0]).toContain('Quantum-L9/explicit-repo');
  });

  it('makes NO outbound call (no GET/PUT) when the config is dry-run', async () => {
    const dryRun: SiteDeploymentConfig = {
      githubToken: '',
      vercelDeployHook: '',
      websiteBotRepo: '',
      sourceBranch: 'main',
      dryRun: true,
    };

    const result = await updateMetaTitle('src/pages/index.astro', 'New Title', 'tenant.com', dryRun);

    // An unconfigured multi-tenant client must be a true no-op — no GitHub read
    // (which would 401 on the empty token) and no write.
    expect(getMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, success: true });
  });
});
