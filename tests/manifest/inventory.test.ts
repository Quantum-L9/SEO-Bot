import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest, globToRegExp } from '../../scripts/manifest/inventory.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seo-manifest-'));
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

describe('repository inventory', () => {
  it('supports single and recursive glob patterns', () => {
    expect(globToRegExp('src/**').test('src/core/a.ts')).toBe(true);
    expect(globToRegExp('*').test('README.md')).toBe(true);
    expect(globToRegExp('*').test('docs/a.md')).toBe(false);
  });

  it('produces deterministic sorted entries', async () => {
    const root = await repository();
    const first = await buildManifest(root);
    const second = await buildManifest(root);
    expect(first).toEqual(second);
    expect(first.entries.map((item) => item.path)).toEqual([...first.entries.map((item) => item.path)].sort((left, right) => left.localeCompare(right)));
  });
});
