import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Chainable @infisical/sdk mock:
//   new InfisicalSDK().auth().universalAuth.login(...)
//   new InfisicalSDK().secrets().listSecrets(...)
const { ctorMock, loginMock, listSecretsMock } = vi.hoisted(() => {
  const loginMock = vi.fn();
  const listSecretsMock = vi.fn();
  const ctorMock = vi.fn(() => ({
    auth: () => ({ universalAuth: { login: loginMock } }),
    secrets: () => ({ listSecrets: listSecretsMock }),
  }));
  return { ctorMock, loginMock, listSecretsMock };
});

vi.mock('@infisical/sdk', () => ({ InfisicalSDK: ctorMock }));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { loadSecrets } from '../../src/core/secrets.js';

// Env keys this suite touches, cleared before each test for isolation.
const TOUCHED = [
  'INFISICAL_CLIENT_ID',
  'INFISICAL_CLIENT_SECRET',
  'INFISICAL_PROJECT_ID',
  'INFISICAL_ENV',
  'INFISICAL_SECRET_PATH',
  'INFISICAL_REQUIRED',
  'INFISICAL_RECURSIVE',
  'INFISICAL_SITE_URL',
  'FETCHED_SECRET',
  'ALREADY_SET',
];

beforeEach(() => {
  for (const k of TOUCHED) delete process.env[k];
  ctorMock.mockClear();
  loginMock.mockReset();
  listSecretsMock.mockReset();
});

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

function configure() {
  process.env.INFISICAL_CLIENT_ID = 'cid';
  process.env.INFISICAL_CLIENT_SECRET = 'csecret';
  process.env.INFISICAL_PROJECT_ID = 'proj';
}

describe('loadSecrets', () => {
  it('is a no-op when Infisical is not configured', async () => {
    const result = await loadSecrets();
    expect(result).toEqual({ loaded: false, injected: 0, source: 'env' });
    expect(ctorMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('throws when INFISICAL_REQUIRED=true but bootstrap vars are missing', async () => {
    process.env.INFISICAL_REQUIRED = 'true';
    await expect(loadSecrets()).rejects.toThrow(/INFISICAL_REQUIRED=true/);
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it('no-ops (does not call the SDK) when only some bootstrap vars are set', async () => {
    process.env.INFISICAL_CLIENT_ID = 'cid';
    // INFISICAL_CLIENT_SECRET and INFISICAL_PROJECT_ID intentionally missing
    const result = await loadSecrets();
    expect(result).toEqual({ loaded: false, injected: 0, source: 'env' });
    expect(ctorMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('authenticates and backfills only missing keys into process.env', async () => {
    configure();
    process.env.ALREADY_SET = 'from-env'; // must NOT be overwritten
    listSecretsMock.mockResolvedValue({
      secrets: [
        { secretKey: 'FETCHED_SECRET', secretValue: 'from-infisical' },
        { secretKey: 'ALREADY_SET', secretValue: 'from-infisical' },
      ],
    });

    const result = await loadSecrets();

    expect(loginMock).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: 'csecret' });
    expect(listSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'prod', projectId: 'proj', secretPath: '/' }),
    );
    expect(process.env.FETCHED_SECRET).toBe('from-infisical'); // injected
    expect(process.env.ALREADY_SET).toBe('from-env'); // preserved
    expect(result).toEqual({ loaded: true, injected: 1, source: 'infisical' });
  });

  it('honours INFISICAL_ENV / INFISICAL_SECRET_PATH overrides', async () => {
    configure();
    process.env.INFISICAL_ENV = 'staging';
    process.env.INFISICAL_SECRET_PATH = '/seo-bot';
    listSecretsMock.mockResolvedValue({ secrets: [] });

    await loadSecrets();

    expect(listSecretsMock).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'staging', secretPath: '/seo-bot' }),
    );
  });

  it('fails soft on fetch error when not required', async () => {
    configure();
    listSecretsMock.mockRejectedValue(new Error('network down'));

    const result = await loadSecrets();

    expect(result).toEqual({ loaded: false, injected: 0, source: 'env' });
  });

  it('aborts on fetch error when INFISICAL_REQUIRED=true', async () => {
    configure();
    process.env.INFISICAL_REQUIRED = 'true';
    listSecretsMock.mockRejectedValue(new Error('network down'));

    await expect(loadSecrets()).rejects.toThrow(/network down/);
  });
});
