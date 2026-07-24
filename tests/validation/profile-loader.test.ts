import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadValidationPolicy } from '../../scripts/validation/profile-loader.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seo-policy-'));
  directories.push(root);
  await mkdir(path.join(root, 'validation'));
  await writeFile(path.join(root, 'validation', 'policy.yaml'), content);
  return root;
}

describe('loadValidationPolicy', () => {
  it('loads JSON-compatible YAML policy', async () => {
    const root = await fixture(JSON.stringify({
      schema_version: '1.0.0', policy_version: '1',
      profiles: {
        ci: { gates: ['test'], allow_pass_with_findings: true, blocked_is_failure: true },
        release: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
        production: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
      },
    }));
    expect((await loadValidationPolicy(root)).profiles.ci.gates).toEqual(['test']);
  });

  it('rejects a missing profile gate list', async () => {
    const root = await fixture(JSON.stringify({ schema_version: '1.0.0', policy_version: '1', profiles: {} }));
    await expect(loadValidationPolicy(root)).rejects.toThrow(/profile ci/);
  });

  it('rejects duplicate gate identifiers', async () => {
    const root = await fixture(JSON.stringify({
      schema_version: '1.0.0', policy_version: '1',
      profiles: {
        ci: { gates: ['test', 'test'], allow_pass_with_findings: true, blocked_is_failure: true },
        release: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
        production: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
      },
    }));
    await expect(loadValidationPolicy(root)).rejects.toThrow(/duplicate gate/);
  });

  it('rejects non-boolean profile policy switches', async () => {
    const root = await fixture(JSON.stringify({
      schema_version: '1.0.0', policy_version: '1',
      profiles: {
        ci: { gates: ['test'], allow_pass_with_findings: 'yes', blocked_is_failure: true },
        release: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
        production: { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true },
      },
    }));
    await expect(loadValidationPolicy(root)).rejects.toThrow(/boolean result policies/);
  });
});
