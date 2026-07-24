import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceWriter } from '../../scripts/validation/core/evidence-writer.js';
import type { GateEvidence } from '../../scripts/validation/types.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seo-evidence-'));
  directories.push(directory);
  return directory;
}

function gate(writer: EvidenceWriter): Omit<GateEvidence, 'evidence_digest'> {
  return {
    schema_version: '1.0.0',
    run_id: writer.runId,
    gate_id: 'test',
    gate_class: 'test',
    profile: 'ci',
    required: true,
    status: 'PASS',
    repository: { name: 'Quantum-L9/SEO-Bot', commit_sha: 'a'.repeat(40), branch: 'main', dirty: false },
    execution: {
      command: ['npm', 'test'], cwd: '.', started_at: new Date(0).toISOString(),
      completed_at: new Date(1).toISOString(), duration_ms: 1, exit_code: 0, signal: null,
    },
    environment: { ci: true, os: 'linux', architecture: 'x64', node_version: 'v22.0.0', npm_version: '10.0.0' },
    assertions: [{ id: 'test.exit', description: 'Authorization: Bearer secret-value', expected: 0, actual: 0, result: 'PASS' }],
    findings: [], blocked_by: [], unknowns: [], artifacts: [],
    logs: { stdout_path: null, stderr_path: null, redacted: true },
  };
}

describe('EvidenceWriter', () => {
  it('redacts direct log content before persistence', async () => {
    const repositoryRoot = await root();
    const writer = new EvidenceWriter(repositoryRoot, 'ci', 'a'.repeat(40));
    await writer.initialize();
    const relative = await writer.writeLog('test', 'stdout', 'Authorization: Bearer secret-value');
    const content = await readFile(path.join(repositoryRoot, relative!), 'utf8');
    expect(content).not.toContain('secret-value');
    expect(content).toContain('[REDACTED:AUTHORIZATION]');
  });

  it('deep-redacts structured gate evidence', async () => {
    const repositoryRoot = await root();
    const writer = new EvidenceWriter(repositoryRoot, 'ci', 'a'.repeat(40));
    await writer.initialize();
    await writer.writeGate(gate(writer));
    const content = await readFile(path.join(writer.runDir, 'test.json'), 'utf8');
    expect(content).not.toContain('secret-value');
    expect(content).toContain('[REDACTED:AUTHORIZATION]');
  });

  it('uses collision-resistant run identifiers', async () => {
    const repositoryRoot = await root();
    const now = new Date('2026-07-20T12:00:00.123Z');
    const left = new EvidenceWriter(repositoryRoot, 'ci', 'a'.repeat(40), now);
    const right = new EvidenceWriter(repositoryRoot, 'ci', 'a'.repeat(40), now);
    expect(left.runId).not.toBe(right.runId);
  });

  it('keeps same-named artifacts distinct and rejects paths outside the repository', async () => {
    const repositoryRoot = await root();
    const outsideRoot = await root();
    await mkdir(path.join(repositoryRoot, 'left'), { recursive: true });
    await mkdir(path.join(repositoryRoot, 'right'), { recursive: true });
    await writeFile(path.join(repositoryRoot, 'left', 'receipt.json'), '{"side":"left"}\n');
    await writeFile(path.join(repositoryRoot, 'right', 'receipt.json'), '{"side":"right"}\n');
    await writeFile(path.join(outsideRoot, 'receipt.json'), '{}\n');
    const writer = new EvidenceWriter(repositoryRoot, 'ci', 'a'.repeat(40));
    await writer.initialize();
    const left = await writer.recordArtifact('left/receipt.json', 'application/json');
    const right = await writer.recordArtifact('right/receipt.json', 'application/json');
    expect(left.path).not.toBe(right.path);
    await expect(writer.recordArtifact(path.join(outsideRoot, 'receipt.json'), 'application/json')).rejects.toThrow(/outside repository root/);
  });
});
