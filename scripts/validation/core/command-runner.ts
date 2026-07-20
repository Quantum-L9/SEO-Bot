import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { redactText } from './redact.js';
import type { ExecutionRecord } from '../types.js';

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandResult {
  execution: ExecutionRecord;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string {
  const candidate = current + chunk.toString('utf8');
  if (Buffer.byteLength(candidate) <= maxBytes) return candidate;
  const marker = '\n[OUTPUT_TRUNCATED_BY_VALIDATOR]\n';
  return Buffer.from(candidate)
    .subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker)))
    .toString('utf8') + marker;
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may already have exited between timeout detection and termination.
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const startedAt = new Date();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const environment = { ...process.env, ...options.env };
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let signal: string | null = null;
  let exitCode: number | null = null;

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, maxOutputBytes); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, maxOutputBytes); });
    child.on('error', (error) => {
      stderr = appendBounded(stderr, Buffer.from(`${error.name}: ${error.message}\n`), maxOutputBytes);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, 'SIGTERM');
      setTimeout(() => terminateProcessTree(child.pid, 'SIGKILL'), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.on('close', (code, closeSignal) => {
      clearTimeout(timer);
      exitCode = code;
      signal = closeSignal;
      resolve();
    });
  });

  const completedAt = new Date();
  return {
    execution: {
      command: [command, ...args],
      cwd: options.cwd,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      exit_code: exitCode,
      signal,
    },
    stdout: redactText(stdout, environment),
    stderr: redactText(stderr, environment),
    timedOut,
  };
}
