import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { EnvironmentRecord, RepositoryContext } from '../types.js';

function read(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${command} exited ${result.status}`);
  return result.stdout.trim();
}

export function findRepositoryRoot(cwd: string): string {
  return read('git', ['rev-parse', '--show-toplevel'], cwd);
}

export function getRepositoryContext(root: string): RepositoryContext {
  const commitSha = read('git', ['rev-parse', 'HEAD'], root);
  const branchRaw = read('git', ['branch', '--show-current'], root);
  const status = read('git', ['status', '--porcelain'], root);
  const remote = (() => {
    try { return read('git', ['remote', 'get-url', 'origin'], root); } catch { return ''; }
  })();
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/i);
  return {
    name: match?.[1] ?? 'Quantum-L9/SEO-Bot',
    commit_sha: commitSha,
    branch: branchRaw || null,
    dirty: status.length > 0,
  };
}

export function getEnvironmentRecord(root: string): EnvironmentRecord {
  const npmVersion = (() => {
    try { return read('npm', ['--version'], root); } catch { return 'unknown'; }
  })();
  return {
    ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
    os: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    node_version: process.version,
    npm_version: npmVersion,
  };
}
