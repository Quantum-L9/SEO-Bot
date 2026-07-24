import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../scripts/validation/core/command-runner.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function cwd(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seo-validator-command-'));
  directories.push(directory);
  return directory;
}

describe('runCommand', () => {
  it('captures stdout, stderr, and exit state', async () => {
    const result = await runCommand(process.execPath, ['-e', 'console.log("out"); console.error("err")'], { cwd: await cwd() });
    expect(result.execution.exit_code).toBe(0);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
    expect(result.timedOut).toBe(false);
  });

  it('captures a nonzero exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(7)'], { cwd: await cwd() });
    expect(result.execution.exit_code).toBe(7);
  });

  it('terminates commands that exceed the timeout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: await cwd(), timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.execution.signal).not.toBeNull();
  });

  it.skipIf(process.platform === 'win32')('terminates descendant processes in the timed-out process group', async () => {
    const directory = await cwd();
    const marker = path.join(directory, 'descendant-survived');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 350)`;
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join(';');
    const result = await runCommand(process.execPath, ['-e', parent], { cwd: directory, timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(access(marker)).rejects.toThrow();
  });
});
