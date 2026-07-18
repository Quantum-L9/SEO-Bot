import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios (site-deployment uses `import axios from 'axios'`).
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('axios', () => ({ default: { post: postMock, get: vi.fn(), put: vi.fn() } }));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { requestSiteBuild, yamlDoubleQuoted, type SiteDeploymentConfig } from '../../src/services/site-deployment.js';

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
  });
});
