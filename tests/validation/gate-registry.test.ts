import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimsGate, sourceGate } from '../../scripts/validation/gate-registry.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'seo-gate-'));
  directories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  await writeFile(path.join(root, 'README.md'), '# Repository\n');
  return root;
}

describe('claimsGate', () => {
  it('scans root Markdown files outside the historical hard-coded list', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'SECURITY.md'), 'Run `npm run imaginary` and the repository is production-ready.\n');
    const result = await claimsGate({ root, profile: 'ci' });
    expect(result.status).toBe('FAIL');
    expect(result.assertions?.find((item) => item.id === 'claims.commands')?.actual).toEqual(
      expect.arrayContaining([expect.stringContaining('SECURITY.md: npm run imaginary')]),
    );
    expect(result.assertions?.find((item) => item.id === 'claims.readiness')?.result).toBe('FAIL');
  });
});

describe('sourceGate', () => {
  it('reports unfinished markers, missing script targets, package-manager drift, and static evidence', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'scripts', 'worker.ts'), '// HACK\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { worker: 'tsx scripts/missing.ts' } }));
    await writeFile(path.join(root, 'README.md'), 'Use pnpm.\n');
    await mkdir(path.join(root, 'validation'), { recursive: true });
    await writeFile(path.join(root, 'validation', 'source_checks.jsonl'), '{"status":"PASS"}\n');
    const result = await sourceGate({ root, profile: 'ci' });
    expect(result.status).toBe('FAIL');
    const byId = new Map(result.assertions?.map((item) => [item.id, item.result]));
    expect(byId.get('source.forbidden-markers')).toBe('FAIL');
    expect(byId.get('source.script-targets')).toBe('FAIL');
    expect(byId.get('source.package-manager-refs')).toBe('FAIL');
    expect(byId.get('source.static-evidence')).toBe('FAIL');
  });
});
