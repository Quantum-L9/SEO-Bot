import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest } from '../../scripts/manifest/check.js';
import { generateManifest } from '../../scripts/manifest/generate.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));
async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seo-manifest-drift-'));
  directories.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'manifest'));
  await writeFile(path.join(root, 'README.md'), '# test\n');
  await writeFile(path.join(root, 'manifest', 'ownership.yaml'), JSON.stringify({
    schema_version: '1.0.0',
    rules: [
      { pattern: '*', owner: 'root', purpose: 'root files', classification: 'documentation' },
      { pattern: 'manifest/**', owner: 'manifest', purpose: 'manifest files', classification: 'configuration' },
    ],
  }));
  return root;
}

describe('manifest drift', () => {
  it('accepts generated manifests', async () => {
    const root = await repository();
    await generateManifest(root);
    await expect(checkManifest(root)).resolves.toBeUndefined();
  });

  it('rejects repository changes after generation', async () => {
    const root = await repository();
    await generateManifest(root);
    await writeFile(path.join(root, 'NEW.md'), '# new\n');
    await expect(checkManifest(root)).rejects.toThrow(/Manifest drift/);
  });
});
