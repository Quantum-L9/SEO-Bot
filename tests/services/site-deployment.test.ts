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
  type SiteDeploymentConfig,
} from '../../src/services/site-deployment.js';
import type { ClientConfig } from '../../src/types/index.js';

/** Build a minimal ClientConfig carrying only a site_deployment block. */
function clientWithDeployment(sd?: Partial<ClientConfig['site_deployment']>): ClientConfig {
  return {
    targetKeywords: [],
    competitors: [],
    linkVelocity: {} as any,
    contentStrategy: {} as any,
    notifications: {} as any,
    ...(sd ? { site_deployment: sd as any } : {}),
  } as ClientConfig;
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

  it('a fully-populated site_deployment yields dryRun:false and carries the fields', () => {
    const cfg = siteConfigFromClient(clientWithDeployment({
      githubToken: 'ghp_live',
      websiteBotRepo: 'Quantum-L9/tenant-a',
      vercelDeployHook: 'https://hook/a',
      sourceBranch: 'release',
    }));
    expect(cfg).toEqual({
      githubToken: 'ghp_live',
      websiteBotRepo: 'Quantum-L9/tenant-a',
      vercelDeployHook: 'https://hook/a',
      sourceBranch: 'release',
      dryRun: false,
    });
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
});
