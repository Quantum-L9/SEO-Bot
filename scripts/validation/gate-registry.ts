import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runCommand } from './core/command-runner.js';
import type {
  GateClass,
  GateResult,
  ValidationAssertion,
  ValidationFinding,
  ValidationProfile,
} from './types.js';

export interface GateContext { root: string; profile: ValidationProfile; }
export interface GateDefinition {
  id: string;
  gateClass: GateClass;
  dependencies: string[];
  execute(context: GateContext): Promise<GateResult>;
}

function assertion(
  id: string,
  description: string,
  expected: unknown,
  actual: unknown,
  result: 'PASS' | 'FAIL' | 'UNKNOWN',
): ValidationAssertion {
  return { id, description, expected, actual, result };
}
function finding(
  id: string,
  severity: 'critical' | 'major' | 'minor' | 'info',
  message: string,
  owner: string,
  blocking = true,
  evidenceRefs: string[] = [],
): ValidationFinding {
  return { id, severity, message, owner, blocking, evidence_refs: evidenceRefs };
}
function deriveStatus(assertions: ValidationAssertion[], findings: ValidationFinding[] = []): GateResult['status'] {
  if (assertions.some((item) => item.result === 'FAIL') || findings.some((item) => item.blocking)) return 'FAIL';
  if (assertions.some((item) => item.result === 'UNKNOWN')) return 'UNKNOWN';
  if (findings.length > 0) return 'PASS_WITH_FINDINGS';
  return 'PASS';
}
async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}
async function walk(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
function syntheticRuntimeEnv(databaseUrl?: string, redisUrl?: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl ?? 'postgres://l9bot:validation-only@127.0.0.1:5432/l9_seo_bot_validation',
    REDIS_URL: redisUrl ?? 'redis://127.0.0.1:6379',
    POSTHOG_API_URL: 'http://127.0.0.1:8000',
    POSTHOG_PERSONAL_API_KEY: 'validation-posthog-key',
    DATAFORSEO_LOGIN: 'validation-user',
    DATAFORSEO_PASSWORD: 'validation-password',
    PAGESPEED_API_KEY: 'validation-pagespeed-key',
    OPENROUTER_API_KEY: 'validation-openrouter-key',
    PERPLEXITY_API_KEY: 'validation-perplexity-key',
    BOT_PORT: '3100',
    BOT_LOG_LEVEL: 'error',
    SITE_DEPLOY_DRY_RUN: 'true',
  };
}

async function preflightGate(context: GateContext): Promise<GateResult> {
  const packageJson = JSON.parse(await readFile(path.join(context.root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
  const presentLockfiles = (await Promise.all(lockfiles.map(async (name) =>
    [name, await exists(path.join(context.root, name))] as const,
  ))).filter(([, present]) => present).map(([name]) => name);
  const requiredFiles = [
    'src/index.ts', 'src/core/config.ts', 'validation/policy.yaml',
    'validation/schemas/gate-evidence.schema.json', 'validation/schemas/run-report.schema.json',
    'validation/schemas/release-receipt.schema.json',
    'manifest/ownership.yaml', 'MANIFEST.json', 'MANIFEST.md',
  ];
  const missingFiles = (await Promise.all(requiredFiles.map(async (name) =>
    [name, await exists(path.join(context.root, name))] as const,
  ))).filter(([, present]) => !present).map(([name]) => name);
  const assertions: ValidationAssertion[] = [
    assertion('preflight.node', 'Node 22 is required', 'v22.x', process.version, /^v22\./.test(process.version) ? 'PASS' : 'FAIL'),
    assertion('preflight.package-manager', 'npm is canonical', 'npm@10.x', packageJson.packageManager ?? null,
      /^npm@10\./.test(packageJson.packageManager ?? '') ? 'PASS' : 'FAIL'),
    assertion('preflight.lockfile', 'Exactly one npm lockfile exists', ['package-lock.json'], presentLockfiles,
      presentLockfiles.length === 1 && presentLockfiles[0] === 'package-lock.json' ? 'PASS' : 'FAIL'),
    assertion('preflight.required-files', 'Required assurance files exist', [], missingFiles,
      missingFiles.length === 0 ? 'PASS' : 'FAIL'),
  ];
  const configText = await readFile(path.join(context.root, 'src/core/config.ts'), 'utf8');
  const envText = await readFile(path.join(context.root, '.env.example'), 'utf8');
  const schemaKeys = [...configText.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*z\./gm)].map((match) => match[1]);
  const envKeys = [...envText.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
  const infrastructureOnly = new Set([
    'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD',
    'POSTHOG_SECRET_KEY', 'POSTHOG_SITE_URL', 'INFISICAL_CLIENT_ID', 'INFISICAL_CLIENT_SECRET',
    'INFISICAL_PROJECT_ID', 'INFISICAL_ENV', 'INFISICAL_SECRET_PATH', 'INFISICAL_SITE_URL',
    'INFISICAL_RECURSIVE', 'INFISICAL_REQUIRED',
  ]);
  const missingFromExample = schemaKeys.filter((key) => !envKeys.includes(key));
  const unexplainedExampleKeys = envKeys.filter((key) => !schemaKeys.includes(key) && !infrastructureOnly.has(key));
  assertions.push(assertion(
    'preflight.env-contract',
    '.env.example covers the Zod config contract',
    { missingFromExample: [], unexplainedExampleKeys: [] },
    { missingFromExample, unexplainedExampleKeys },
    missingFromExample.length === 0 && unexplainedExampleKeys.length === 0 ? 'PASS' : 'FAIL',
  ));
  if (context.profile !== 'ci') {
    const worktree = await runCommand('git', ['status', '--porcelain'], { cwd: context.root, timeoutMs: 30_000 });
    const clean = worktree.execution.exit_code === 0 && worktree.stdout.trim().length === 0;
    assertions.push(assertion('preflight.clean-worktree', 'Release evidence requires a clean worktree', true, clean,
      clean ? 'PASS' : 'FAIL'));
  }
  return { status: deriveStatus(assertions), assertions };
}

function parseScriptFileReferences(command: string): string[] {
  const references = new Set<string>();
  for (const match of command.matchAll(/\b((?:src|scripts|dist)\/[^\s"']+\.(?:ts|js|mjs|cjs))\b/g)) references.add(match[1]);
  for (const match of command.matchAll(/test\s+-f\s+([^\s"']+)/g)) references.add(match[1]);
  return [...references];
}

export async function sourceGate(context: GateContext): Promise<GateResult> {
  const scanRoots = ['src', 'scripts', '.github/workflows'];
  const files = (await Promise.all(scanRoots.map((root) => walk(path.join(context.root, root))))).flat();
  const marker = ['TO', 'DO', '|FIX', 'ME', '|X', 'XX', '|HA', 'CK'].join('');
  const unimplemented = ['Not', 'Implemented', '|Not', ' implemented'].join('');
  const placeholderBehavior = ['place', 'holder behavior'].join('');
  const forbidden = new RegExp(`\\b(?:${marker}|${unimplemented})\\b|${placeholderBehavior}`, 'i');
  const findings: ValidationFinding[] = [];
  for (const file of files) {
    const relative = path.relative(context.root, file).replaceAll(path.sep, '/');
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (forbidden.test(line)) findings.push(finding(
        `source.forbidden-marker.${relative}.${index + 1}`,
        'major', `Forbidden unfinished-work marker in ${relative}:${index + 1}`, relative, true,
        [`${relative}:${index + 1}`],
      ));
    });
  }
  const packageJson = JSON.parse(await readFile(path.join(context.root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const missingTargets: string[] = [];
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    for (const target of parseScriptFileReferences(command)) {
      if (target.startsWith('dist/')) continue;
      if (!(await exists(path.join(context.root, target)))) missingTargets.push(`${name} -> ${target}`);
    }
  }
  const managerFiles = [
    'package.json', 'README.md', 'RUNBOOK.md', 'VALIDATION.md', 'AGENTS.md', 'CONTRIBUTING.md',
    'docker/Dockerfile', 'docker-compose.yml', 'scripts/deploy.sh', '.github/workflows/ci.yml',
  ];
  const nonNpmRefs: string[] = [];
  for (const relative of managerFiles) {
    const target = path.join(context.root, relative);
    if (await exists(target)) {
      const text = await readFile(target, 'utf8');
      if (/\b(?:pnpm|yarn|bun)\b/i.test(text)) nonNpmRefs.push(relative);
    }
  }
  const legacy = [
    'validation/preflight_checks.jsonl', 'validation/source_checks.jsonl',
    'validation/build_checks.jsonl', 'validation/db_checks.jsonl',
    'validation/validation_report.yaml',
  ];
  const staticEvidence = (await Promise.all(legacy.map(async (relative) =>
    [relative, await exists(path.join(context.root, relative))] as const,
  ))).filter(([, present]) => present).map(([relative]) => relative);
  const assertions = [
    assertion('source.forbidden-markers', 'Production and tooling code has no unfinished-work markers', [],
      findings.map((item) => item.evidence_refs[0]), findings.length === 0 ? 'PASS' : 'FAIL'),
    assertion('source.script-targets', 'Every package script source target exists', [], missingTargets,
      missingTargets.length === 0 ? 'PASS' : 'FAIL'),
    assertion('source.package-manager-refs', 'Operational files use npm only', [], nonNpmRefs,
      nonNpmRefs.length === 0 ? 'PASS' : 'FAIL'),
    assertion('source.static-evidence', 'Legacy pass-only evidence is absent', [], staticEvidence,
      staticEvidence.length === 0 ? 'PASS' : 'FAIL'),
  ];
  return { status: deriveStatus(assertions, findings), assertions, findings };
}

async function commandGate(
  context: GateContext,
  gateId: string,
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<GateResult> {
  const result = await runCommand(command, args, { cwd: context.root, timeoutMs, env });
  const passed = result.execution.exit_code === 0 && !result.timedOut;
  return {
    status: passed ? 'PASS' : 'FAIL',
    assertions: [assertion(
      `${gateId}.exit`, `${[command, ...args].join(' ')} exits successfully`,
      { exitCode: 0, timedOut: false },
      { exitCode: result.execution.exit_code, timedOut: result.timedOut },
      passed ? 'PASS' : 'FAIL',
    )],
    execution: result.execution,
    stdout: result.stdout,
    stderr: result.stderr,
    findings: passed ? [] : [finding(`${gateId}.command-failed`, 'critical', `${gateId} command failed`, gateId)],
  };
}
async function buildGate(context: GateContext): Promise<GateResult> {
  const started = Date.now();
  const result = await commandGate(context, 'build', 'npm', ['run', 'build'], 10 * 60 * 1000);
  const outputPath = path.join(context.root, 'dist', 'index.js');
  const outputPresent = await exists(outputPath);
  // Allow one second for coarse filesystem timestamp precision while still
  // proving the build output was created or refreshed by this gate execution.
  const outputFresh = outputPresent ? (await stat(outputPath)).mtimeMs >= started - 1_000 : false;
  result.assertions = [
    ...(result.assertions ?? []),
    assertion('build.output-exists', 'dist/index.js exists', true, outputPresent, outputPresent ? 'PASS' : 'FAIL'),
    assertion('build.output-fresh', 'dist/index.js was produced by this run', true, outputFresh, outputFresh ? 'PASS' : 'FAIL'),
  ];
  result.status = deriveStatus(result.assertions, result.findings ?? []);
  return result;
}
async function manifestGate(context: GateContext): Promise<GateResult> {
  return commandGate(context, 'manifest', 'npm', ['run', 'manifest:check'], 2 * 60 * 1000);
}
export async function claimsGate(context: GateContext): Promise<GateResult> {
  const packageJson = JSON.parse(await readFile(path.join(context.root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scriptNames = new Set(Object.keys(packageJson.scripts ?? {}));
  const rootDocumentation = (await readdir(context.root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const discoveredDocumentation = (await Promise.all(['docs', 'adr'].map(async (directory) =>
    (await walk(path.join(context.root, directory)))
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.relative(context.root, file).replaceAll(path.sep, '/')),
  ))).flat();
  const documentation = [...new Set([...rootDocumentation, ...discoveredDocumentation])].sort();
  const undefinedCommands: string[] = [];
  const prohibitedClaims: string[] = [];
  const patterns = [
    /convergence_status:\s*converged/i,
    /execution_readiness:\s*pass/i,
    /all checks (?:are )?pass(?:ed|ing)/i,
    /\b(?:repository|service|system|bot) is production[- ]ready\b/i,
    /\bproduction readiness:\s*(?:pass|ready|true)\b/i,
    /\brelease readiness:\s*(?:pass|ready|true)\b/i,
  ];
  for (const relative of documentation) {
    const filePath = path.join(context.root, relative);
    if (!(await exists(filePath))) continue;
    const text = await readFile(filePath, 'utf8');
    const historical = relative === 'docs/alignment_report.md' && text.startsWith('# SUPERSEDED HISTORICAL REPORT');
    for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      if (!scriptNames.has(match[1])) undefinedCommands.push(`${relative}: npm run ${match[1]}`);
    }
    if (!historical) for (const pattern of patterns) if (pattern.test(text)) prohibitedClaims.push(`${relative}: ${pattern.source}`);
  }
  const assertions = [
    assertion('claims.commands', 'Documented npm commands exist', [], undefinedCommands,
      undefinedCommands.length === 0 ? 'PASS' : 'FAIL'),
    assertion('claims.readiness', 'Current docs contain no unsupported readiness claim', [], prohibitedClaims,
      prohibitedClaims.length === 0 ? 'PASS' : 'FAIL'),
  ];
  return { status: deriveStatus(assertions), assertions };
}

function parsePublishedPort(output: string): number {
  const line = output.trim().split(/\r?\n/)[0] ?? '';
  const match = line.match(/:(\d+)$/);
  if (!match) throw new Error(`Unable to parse Docker port mapping: ${line}`);
  return Number(match[1]);
}
async function dockerAvailable(root: string): Promise<boolean> {
  const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], { cwd: root, timeoutMs: 30_000 });
  return result.execution.exit_code === 0;
}

async function databaseGate(context: GateContext): Promise<GateResult> {
  if (!(await dockerAvailable(context.root))) {
    return {
      status: 'BLOCKED',
      blocked_by: [{ type: 'environment', name: 'docker', reason: 'Docker daemon is unavailable' }],
      assertions: [assertion('database.docker', 'Docker daemon is available', true, false, 'UNKNOWN')],
    };
  }
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const containerName = `seo-bot-db-validation-${suffix}`;
  const databaseName = `seo_bot_validation_${randomBytes(4).toString('hex')}`;
  let stdout = '';
  let stderr = '';
  const assertions: ValidationAssertion[] = [];
  const findings: ValidationFinding[] = [];
  try {
    const start = await runCommand('docker', [
      'run', '--detach', '--rm', '--name', containerName, '-P',
      '-e', 'POSTGRES_USER=l9bot', '-e', 'POSTGRES_PASSWORD=validation-only',
      '-e', `POSTGRES_DB=${databaseName}`, 'postgres:16-alpine',
    ], { cwd: context.root, timeoutMs: 2 * 60 * 1000 });
    stdout += start.stdout; stderr += start.stderr;
    if (start.execution.exit_code !== 0) throw new Error('Unable to start disposable PostgreSQL container');
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const check = await runCommand('docker', ['exec', containerName, 'pg_isready', '-U', 'l9bot', '-d', databaseName], {
        cwd: context.root, timeoutMs: 10_000,
      });
      if (check.execution.exit_code === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assertions.push(assertion('database.ready', 'Disposable PostgreSQL becomes ready', true, ready, ready ? 'PASS' : 'FAIL'));
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    const portResult = await runCommand('docker', ['port', containerName, '5432/tcp'], { cwd: context.root, timeoutMs: 10_000 });
    const port = parsePublishedPort(portResult.stdout);
    const migrationEnv = syntheticRuntimeEnv(`postgres://l9bot:validation-only@127.0.0.1:${port}/${databaseName}`);
    const first = await runCommand('npm', ['run', 'migrate'], { cwd: context.root, env: migrationEnv, timeoutMs: 5 * 60 * 1000 });
    stdout += first.stdout; stderr += first.stderr;
    assertions.push(assertion('database.first-migration', 'All migrations apply to an empty database', 0,
      first.execution.exit_code, first.execution.exit_code === 0 ? 'PASS' : 'FAIL'));
    const second = await runCommand('npm', ['run', 'migrate'], { cwd: context.root, env: migrationEnv, timeoutMs: 5 * 60 * 1000 });
    stdout += second.stdout; stderr += second.stderr;
    assertions.push(assertion('database.idempotent', 'A second migration run is idempotent', 0,
      second.execution.exit_code, second.execution.exit_code === 0 ? 'PASS' : 'FAIL'));
    const tableQuery = await runCommand('docker', [
      'exec', containerName, 'psql', '-U', 'l9bot', '-d', databaseName, '-Atc',
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;",
    ], { cwd: context.root, timeoutMs: 30_000 });
    stdout += tableQuery.stdout; stderr += tableQuery.stderr;
    const actualTables = tableQuery.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const schemaSources = [
      await readFile(path.join(context.root, 'src/core/database/schema.ts'), 'utf8'),
      await readFile(path.join(context.root, 'src/core/database/schema-extensions.ts'), 'utf8'),
    ];
    const expectedTables = [...new Set(schemaSources.flatMap((text) =>
      [...text.matchAll(/pgTable\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ))].sort();
    const missingTables = expectedTables.filter((table) => !actualTables.includes(table));
    assertions.push(assertion('database.tables', 'Every Drizzle table exists after migration', [], missingTables,
      missingTables.length === 0 ? 'PASS' : 'FAIL'));
    const journalQuery = await runCommand('docker', [
      'exec', containerName, 'psql', '-U', 'l9bot', '-d', databaseName, '-Atc',
      "SELECT count(*) FROM drizzle.__drizzle_migrations;",
    ], { cwd: context.root, timeoutMs: 30_000 });
    stdout += journalQuery.stdout; stderr += journalQuery.stderr;
    const journalCount = Number(journalQuery.stdout.trim());
    const journalValid = journalQuery.execution.exit_code === 0 && Number.isInteger(journalCount) && journalCount > 0;
    assertions.push(assertion('database.migration-journal', 'Drizzle migration journal records applied migrations', '>0',
      journalQuery.execution.exit_code === 0 ? journalCount : journalQuery.stderr.trim(), journalValid ? 'PASS' : 'FAIL'));
    const receiptPath = path.join(context.root, '.validation-tmp', `${suffix}-database-receipt.json`);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({ databaseName, expectedTables, actualTables, missingTables, journalCount }, null, 2) + '\n', { mode: 0o600 });
    return {
      status: deriveStatus(assertions, findings), assertions, findings, stdout, stderr,
      artifact_sources: [{ path: receiptPath, media_type: 'application/json', cleanup: true }],
    };
  } catch (error) {
    findings.push(finding('database.execution', 'critical', (error as Error).message, 'database'));
  } finally {
    const cleanup = await runCommand('docker', ['rm', '--force', containerName], { cwd: context.root, timeoutMs: 30_000 });
    if (cleanup.execution.exit_code !== 0 && !/No such container/i.test(cleanup.stderr)) {
      findings.push(finding('database.cleanup', 'major', 'Disposable database cleanup failed', 'database'));
      stderr += cleanup.stderr;
    }
  }
  return { status: deriveStatus(assertions, findings), assertions, findings, stdout, stderr };
}

async function containerGate(context: GateContext): Promise<GateResult> {
  if (!(await dockerAvailable(context.root))) {
    return {
      status: 'BLOCKED',
      blocked_by: [{ type: 'environment', name: 'docker', reason: 'Docker daemon is unavailable' }],
      assertions: [assertion('container.docker', 'Docker daemon is available', true, false, 'UNKNOWN')],
    };
  }
  if (!process.env.NODE_AUTH_TOKEN) {
    return {
      status: 'BLOCKED',
      blocked_by: [{ type: 'credential', name: 'NODE_AUTH_TOKEN', reason: 'Private packages require read:packages authentication' }],
      assertions: [assertion('container.package-auth', 'Private package token is present', true, false, 'UNKNOWN')],
    };
  }
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const tag = `seo-bot-validation:${suffix}`;
  const networkName = `seo-bot-validation-${suffix}`;
  const postgresName = `seo-bot-validation-postgres-${suffix}`;
  const redisName = `seo-bot-validation-redis-${suffix}`;
  const appName = `seo-bot-validation-app-${suffix}`;
  const databaseName = `seo_bot_validation_${randomBytes(4).toString('hex')}`;
  const assertions: ValidationAssertion[] = [];
  const findings: ValidationFinding[] = [];
  let stdout = '';
  let stderr = '';
  let primaryExecution: GateResult['execution'];
  const append = (result: Awaited<ReturnType<typeof runCommand>>): void => { stdout += result.stdout; stderr += result.stderr; };
  try {
    const build = await runCommand('docker', [
      'build', '--secret', 'id=npm_token,env=NODE_AUTH_TOKEN', '-f', 'docker/Dockerfile', '-t', tag, '.',
    ], { cwd: context.root, timeoutMs: 20 * 60 * 1000, env: { DOCKER_BUILDKIT: '1' } });
    append(build); primaryExecution = build.execution;
    assertions.push(assertion('container.build', 'Production image builds', 0, build.execution.exit_code,
      build.execution.exit_code === 0 ? 'PASS' : 'FAIL'));
    if (build.execution.exit_code !== 0) throw new Error('Production image failed to build');
    const inspect = await runCommand('docker', ['image', 'inspect', tag, '--format', '{{.Config.User}}'], {
      cwd: context.root, timeoutMs: 30_000,
    });
    append(inspect);
    const user = inspect.stdout.trim();
    assertions.push(assertion('container.non-root', 'Production image runs non-root', 'node', user,
      user === 'node' || (/^\d+$/.test(user) && user !== '0') ? 'PASS' : 'FAIL'));
    const imageIdResult = await runCommand('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], {
      cwd: context.root, timeoutMs: 30_000,
    });
    append(imageIdResult);
    const imageDigest = imageIdResult.stdout.trim();
    assertions.push(assertion('container.image-digest', 'Production image has a content digest', 'sha256: followed by 64 lowercase hexadecimal characters', imageDigest,
      /^sha256:[a-f0-9]{64}$/.test(imageDigest) ? 'PASS' : 'FAIL'));
    const deps = await runCommand('docker', [
      'run', '--rm', '--entrypoint', 'sh', tag, '-c',
      'test ! -d node_modules/typescript && test ! -d node_modules/vitest && test ! -d node_modules/eslint',
    ], { cwd: context.root, timeoutMs: 60_000 });
    append(deps);
    assertions.push(assertion('container.production-dependencies', 'Development dependencies are absent', 0,
      deps.execution.exit_code, deps.execution.exit_code === 0 ? 'PASS' : 'FAIL'));
    const network = await runCommand('docker', ['network', 'create', networkName], { cwd: context.root, timeoutMs: 30_000 });
    append(network);
    if (network.execution.exit_code !== 0) throw new Error('Unable to create validation network');
    const postgres = await runCommand('docker', [
      'run', '--detach', '--rm', '--name', postgresName, '--network', networkName, '--network-alias', 'postgres',
      '-e', 'POSTGRES_USER=l9bot', '-e', 'POSTGRES_PASSWORD=validation-only', '-e', `POSTGRES_DB=${databaseName}`,
      'postgres:16-alpine',
    ], { cwd: context.root, timeoutMs: 2 * 60 * 1000 });
    append(postgres);
    if (postgres.execution.exit_code !== 0) throw new Error('Unable to start validation PostgreSQL');
    const redis = await runCommand('docker', [
      'run', '--detach', '--rm', '--name', redisName, '--network', networkName, '--network-alias', 'redis', 'redis:7-alpine',
    ], { cwd: context.root, timeoutMs: 2 * 60 * 1000 });
    append(redis);
    if (redis.execution.exit_code !== 0) throw new Error('Unable to start validation Redis');
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const pgReady = await runCommand('docker', ['exec', postgresName, 'pg_isready', '-U', 'l9bot', '-d', databaseName], {
        cwd: context.root, timeoutMs: 10_000,
      });
      const redisReady = await runCommand('docker', ['exec', redisName, 'redis-cli', 'ping'], {
        cwd: context.root, timeoutMs: 10_000,
      });
      if (pgReady.execution.exit_code === 0 && redisReady.execution.exit_code === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assertions.push(assertion('container.dependencies-ready', 'Disposable dependencies become ready', true, ready,
      ready ? 'PASS' : 'FAIL'));
    if (!ready) throw new Error('Disposable dependencies did not become ready');
    const runtimeEnv = syntheticRuntimeEnv(
      `postgres://l9bot:validation-only@postgres:5432/${databaseName}`,
      'redis://redis:6379',
    );
    const envArgs = Object.entries(runtimeEnv).flatMap(([name, value]) => value === undefined ? [] : ['-e', `${name}=${value}`]);
    const migration = await runCommand('docker', [
      'run', '--rm', '--network', networkName, ...envArgs, '--entrypoint', 'node', tag, 'dist/core/database/migrate.js',
    ], { cwd: context.root, timeoutMs: 5 * 60 * 1000 });
    append(migration);
    assertions.push(assertion('container.migrations', 'Production image applies migrations', 0,
      migration.execution.exit_code, migration.execution.exit_code === 0 ? 'PASS' : 'FAIL'));
    if (migration.execution.exit_code !== 0) throw new Error('Production image migration failed');
    const app = await runCommand('docker', [
      'run', '--detach', '--rm', '--name', appName, '--network', networkName, '-P', ...envArgs, tag,
    ], { cwd: context.root, timeoutMs: 2 * 60 * 1000 });
    append(app);
    if (app.execution.exit_code !== 0) throw new Error('Unable to start production image');
    let healthBody = '';
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const health = await runCommand('docker', ['exec', appName, 'curl', '--fail', '--silent', 'http://127.0.0.1:3100/health'], {
        cwd: context.root, timeoutMs: 10_000,
      });
      if (health.execution.exit_code === 0) { healthBody = health.stdout.trim(); healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assertions.push(assertion('container.health', 'Production container reaches health endpoint', true, healthy,
      healthy ? 'PASS' : 'FAIL'));
    if (healthy) {
      try {
        const body = JSON.parse(healthBody) as Record<string, unknown>;
        assertions.push(assertion('container.health-status', 'Container reports healthy', 'healthy', body.status,
          body.status === 'healthy' ? 'PASS' : 'FAIL'));
      } catch {
        assertions.push(assertion('container.health-json', 'Health response is JSON', true, healthBody, 'FAIL'));
      }
    }
  } catch (error) {
    findings.push(finding('container.execution', 'critical', (error as Error).message, 'runtime-platform'));
    const logs = await runCommand('docker', ['logs', appName], { cwd: context.root, timeoutMs: 30_000 });
    append(logs);
  } finally {
    for (const resource of [appName, redisName, postgresName]) {
      const cleanup = await runCommand('docker', ['rm', '--force', resource], { cwd: context.root, timeoutMs: 30_000 });
      if (cleanup.execution.exit_code !== 0 && !/No such container/i.test(cleanup.stderr)) {
        findings.push(finding(`container.cleanup.${resource}`, 'minor', `Unable to remove ${resource}`, 'runtime-platform', false));
        append(cleanup);
      }
    }
    const networkCleanup = await runCommand('docker', ['network', 'rm', networkName], { cwd: context.root, timeoutMs: 30_000 });
    if (networkCleanup.execution.exit_code !== 0 && !/not found/i.test(networkCleanup.stderr)) {
      findings.push(finding('container.cleanup.network', 'minor', 'Unable to remove validation network', 'runtime-platform', false));
      append(networkCleanup);
    }
    const imageCleanup = await runCommand('docker', ['image', 'rm', '--force', tag], { cwd: context.root, timeoutMs: 60_000 });
    if (imageCleanup.execution.exit_code !== 0 && !/No such image/i.test(imageCleanup.stderr)) {
      findings.push(finding('container.cleanup.image', 'minor', 'Unable to remove validation image', 'runtime-platform', false));
      append(imageCleanup);
    }
  }
  return { status: deriveStatus(assertions, findings), assertions, findings, execution: primaryExecution, stdout, stderr };
}

async function runtimeHealthGate(_context: GateContext): Promise<GateResult> {
  const baseUrl = process.env.SEO_BOT_BASE_URL;
  if (!baseUrl) return {
    status: 'BLOCKED',
    blocked_by: [{ type: 'environment', name: 'SEO_BOT_BASE_URL', reason: 'No deployed SEO Bot URL was provided' }],
    assertions: [assertion('runtime-health.url', 'A deployed URL is provided', true, false, 'UNKNOWN')],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL('/health', baseUrl), { signal: controller.signal });
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.json() as Record<string, unknown>;
    const assertions = [
      assertion('runtime-health.http', 'Health endpoint returns HTTP 200', 200, response.status, response.status === 200 ? 'PASS' : 'FAIL'),
      assertion('runtime-health.content-type', 'Health endpoint returns JSON', true, contentType.includes('application/json'),
        contentType.includes('application/json') ? 'PASS' : 'FAIL'),
      assertion('runtime-health.status', 'Health status is healthy', 'healthy', body.status, body.status === 'healthy' ? 'PASS' : 'FAIL'),
    ];
    return { status: deriveStatus(assertions), assertions, stdout: JSON.stringify(body) };
  } catch (error) {
    return {
      status: 'FAIL',
      assertions: [assertion('runtime-health.request', 'Health endpoint is reachable', true, false, 'FAIL')],
      findings: [finding('runtime-health.unreachable', 'critical', (error as Error).message, 'runtime')],
    };
  } finally { clearTimeout(timeout); }
}

async function tenantReadinessGate(context: GateContext): Promise<GateResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return {
    status: 'BLOCKED',
    blocked_by: [{ type: 'credential', name: 'DATABASE_URL', reason: 'Production database URL is required for read-only readiness' }],
    assertions: [assertion('tenant.database-url', 'Production DATABASE_URL is provided', true, false, 'UNKNOWN')],
  };
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch (error) {
    return {
      status: 'FAIL',
      assertions: [assertion('tenant.database-url-format', 'DATABASE_URL is a valid URL', true, false, 'FAIL')],
      findings: [finding('tenant.database-url-invalid', 'critical', (error as Error).message, 'database')],
    };
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return {
    status: 'FAIL',
    assertions: [assertion('tenant.database-protocol', 'DATABASE_URL uses PostgreSQL', 'postgres:', parsed.protocol, 'FAIL')],
  };
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    options: '-c default_transaction_read_only=on',
  });
  try {
    const result = await pool.query<{
      id: string;
      domain: string;
      posthog_project_id: string | null;
      posthog_api_key: string | null;
      config: Record<string, unknown>;
    }>('SELECT id, domain, posthog_project_id, posthog_api_key, config FROM clients WHERE active = true ORDER BY domain');
    const incomplete: string[] = [];
    for (const client of result.rows) {
      const deployment = (client.config?.site_deployment ?? null) as Record<string, unknown> | null;
      if (!deployment) continue;
      const hasToken = typeof deployment.githubToken === 'string' && deployment.githubToken.trim().length > 0;
      const hasRepo = typeof deployment.websiteBotRepo === 'string' && deployment.websiteBotRepo.trim().length > 0;
      if (hasToken !== hasRepo) incomplete.push(client.domain);
    }
    const scheduler = await readFile(path.join(context.root, 'src/core/scheduler.ts'), 'utf8');
    const disabled = /serp:execute-surpass-plans[\s\S]{0,1500}enabled:\s*false/.test(scheduler);
    const assertions = [
      assertion('tenant.active-client', 'At least one active tenant exists', '>=1', result.rows.length,
        result.rows.length > 0 ? 'PASS' : 'FAIL'),
      assertion('tenant.deploy-config', 'Deployment credentials are complete pairs', [], incomplete,
        incomplete.length === 0 ? 'PASS' : 'FAIL'),
      assertion('tenant.live-mutation-gate', 'Autonomous live mutation remains disabled', true, disabled,
        disabled ? 'PASS' : 'FAIL'),
    ];
    return { status: deriveStatus(assertions), assertions };
  } catch (error) {
    return {
      status: 'FAIL',
      assertions: [assertion('tenant.query', 'Read-only tenant query succeeds', true, false, 'FAIL')],
      findings: [finding('tenant.query-failed', 'critical', (error as Error).message, 'database')],
    };
  } finally { await pool.end(); }
}

async function posthogReadinessGate(): Promise<GateResult> {
  const apiUrl = process.env.POSTHOG_API_URL;
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!apiUrl || !apiKey) return {
    status: 'BLOCKED',
    blocked_by: [{ type: 'credential', name: 'POSTHOG_API_URL/POSTHOG_PERSONAL_API_KEY', reason: 'Read-only PostHog access is required' }],
    assertions: [assertion('posthog.credentials', 'PostHog URL and API key are provided', true, false, 'UNKNOWN')],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL('/api/projects/', apiUrl), {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
    });
    const body = await response.text();
    const assertions = [assertion('posthog.project-access', 'PostHog project list is readable', 200, response.status,
      response.ok ? 'PASS' : 'FAIL')];
    return { status: deriveStatus(assertions), assertions, stdout: body.slice(0, 2_000) };
  } catch (error) {
    return {
      status: 'FAIL',
      assertions: [assertion('posthog.request', 'PostHog API is reachable', true, false, 'FAIL')],
      findings: [finding('posthog.unreachable', 'major', (error as Error).message, 'posthog')],
    };
  } finally { clearTimeout(timeout); }
}

export const GATES: GateDefinition[] = [
  { id: 'preflight', gateClass: 'static', dependencies: [], execute: preflightGate },
  { id: 'source', gateClass: 'static', dependencies: ['preflight'], execute: sourceGate },
  { id: 'typecheck', gateClass: 'build', dependencies: ['source'], execute: (context) => commandGate(context, 'typecheck', 'npm', ['run', 'typecheck'], 10 * 60 * 1000) },
  { id: 'lint', gateClass: 'build', dependencies: ['source'], execute: (context) => commandGate(context, 'lint', 'npm', ['run', 'lint'], 10 * 60 * 1000) },
  { id: 'test', gateClass: 'test', dependencies: ['source'], execute: (context) => commandGate(context, 'test', 'npm', ['test'], 15 * 60 * 1000, { NODE_ENV: 'test' }) },
  { id: 'build', gateClass: 'build', dependencies: ['typecheck'], execute: buildGate },
  { id: 'database', gateClass: 'database', dependencies: ['build'], execute: databaseGate },
  { id: 'manifest', gateClass: 'static', dependencies: ['source'], execute: manifestGate },
  { id: 'claims', gateClass: 'static', dependencies: ['source'], execute: claimsGate },
  { id: 'container', gateClass: 'container', dependencies: ['build', 'test'], execute: containerGate },
  { id: 'runtime-health', gateClass: 'operational', dependencies: [], execute: runtimeHealthGate },
  { id: 'tenant-readiness', gateClass: 'operational', dependencies: [], execute: tenantReadinessGate },
  { id: 'posthog-readiness', gateClass: 'integration', dependencies: [], execute: () => posthogReadinessGate() },
];
export const GATE_BY_ID = new Map(GATES.map((gate) => [gate.id, gate]));
