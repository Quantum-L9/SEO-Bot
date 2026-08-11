import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadInfisicalSecrets = vi.hoisted(() => vi.fn());

vi.mock('@quantum-l9/infisical-config', () => ({
  loadSecrets: loadInfisicalSecrets,
}));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { loadSecrets } from '../../src/core/secrets.js';

beforeEach(() => {
  loadInfisicalSecrets.mockReset();
});

describe('loadSecrets (package adapter)', () => {
  it('delegates to @quantum-l9/infisical-config with the module logger', async () => {
    loadInfisicalSecrets.mockResolvedValue({ loaded: true, injected: 2, source: 'infisical' });
    const result = await loadSecrets();
    expect(result).toEqual({ loaded: true, injected: 2, source: 'infisical' });
    expect(loadInfisicalSecrets).toHaveBeenCalledTimes(1);
    const arg = loadInfisicalSecrets.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ logger: expect.any(Object) }));
  });

  it('propagates package failures', async () => {
    loadInfisicalSecrets.mockRejectedValue(new Error('INFISICAL_REQUIRED=true boom'));
    await expect(loadSecrets()).rejects.toThrow(/INFISICAL_REQUIRED/);
  });
});
