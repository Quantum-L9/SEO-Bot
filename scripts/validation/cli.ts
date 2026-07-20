import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GATE_BY_ID, type GateDefinition, type GateContext } from './gate-registry.js';
import { EvidenceWriter, canonicalJson, sha256 } from './core/evidence-writer.js';
import { getEnvironmentRecord, getRepositoryContext } from './core/repository-context.js';
import { validateReleaseReceipt } from './core/schema-validator.js';
import { loadValidationPolicy } from './profile-loader.js';
import {
  aggregateStatus,
  exitCodeForStatus,
  isProfilePassing,
  type ExecutionRecord,
  type GateEvidence,
  type GateResult,
  type ReleaseReceipt,
  type RunReport,
  type ValidationFinding,
  type ValidationProfile,
  type ValidationStatus,
  type ValidationUnknown,
} from './types.js';

const ROOT = process.cwd();

interface ParsedArguments {
  command: 'run' | 'clean';
  profile?: ValidationProfile;
  gate?: string;
}

function usage(): never {
  console.error('Usage: tsx scripts/validation/cli.ts run (--profile ci|release|production | --gate GATE_ID)');
  console.error('       tsx scripts/validation/cli.ts clean');
  process.exit(64);
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command] = argv;
  if (command === 'clean') return { command: 'clean' };
  if (command !== 'run') return usage();
  const profileIndex = argv.indexOf('--profile');
  const gateIndex = argv.indexOf('--gate');
  if ((profileIndex >= 0) === (gateIndex >= 0)) return usage();
  if (profileIndex >= 0) {
    const profile = argv[profileIndex + 1] as ValidationProfile | undefined;
    if (!profile || !['ci', 'release', 'production'].includes(profile)) return usage();
    return { command: 'run', profile };
  }
  const gate = argv[gateIndex + 1];
  if (!gate || !GATE_BY_ID.has(gate)) return usage();
  return { command: 'run', gate };
}

function dependencyClosure(gateIds: string[]): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(gateId: string): void {
    if (visited.has(gateId)) return;
    if (visiting.has(gateId)) throw new Error(`Validation dependency cycle at ${gateId}`);
    const gate = GATE_BY_ID.get(gateId);
    if (!gate) throw new Error(`Unknown validation gate: ${gateId}`);
    visiting.add(gateId);
    for (const dependency of gate.dependencies) visit(dependency);
    visiting.delete(gateId);
    visited.add(gateId);
    ordered.push(gateId);
  }
  for (const gateId of gateIds) visit(gateId);
  return ordered;
}

function normalizeExecution(partial: GateResult['execution'], startedAt: string, completedAt: string, durationMs: number): ExecutionRecord {
  return {
    command: partial?.command ?? [],
    cwd: partial?.cwd ?? '.',
    started_at: partial?.started_at ?? startedAt,
    completed_at: partial?.completed_at ?? completedAt,
    duration_ms: partial?.duration_ms ?? Math.round(durationMs),
    exit_code: partial?.exit_code ?? null,
    signal: partial?.signal ?? null,
  };
}

function dependencyBlockedResult(gate: GateDefinition, failedDependencies: string[]): GateResult {
  return {
    status: 'BLOCKED',
    blocked_by: [{
      type: 'dependency',
      name: failedDependencies.join(', '),
      reason: `Required upstream gate did not pass: ${failedDependencies.join(', ')}`,
    }],
    assertions: [{
      id: `${gate.id}.dependencies`,
      description: 'Required upstream validation gates pass',
      expected: [],
      actual: failedDependencies,
      result: 'UNKNOWN',
    }],
  };
}

function internalFailureResult(gateId: string, error: unknown): GateResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'UNKNOWN',
    assertions: [{
      id: `${gateId}.runner`,
      description: 'Gate evaluator executes reliably',
      expected: 'success',
      actual: message,
      result: 'UNKNOWN',
    }],
    unknowns: [{
      id: `${gateId}.runner-error`,
      description: `The assurance runner could not evaluate ${gateId}: ${message}`,
      required_resolution: 'Repair the gate evaluator and rerun the exact commit.',
    }],
    stderr: message,
  };
}

function releaseReceipt(report: RunReport, evidence: GateEvidence[]): Omit<ReleaseReceipt, 'receipt_digest'> {
  const imageDigest = evidence
    .find((item) => item.gate_id === 'container')
    ?.assertions.find((item) => item.id === 'container.image-digest')?.actual;
  return {
    schema_version: '1.0.0',
    repository: report.repository,
    image: { digest: typeof imageDigest === 'string' ? imageDigest : null },
    validation_run_id: report.run_id,
    profile: report.profile as 'release' | 'production',
    overall_status: report.overall_status,
    required_gates: report.gates.filter((gate) => gate.required),
    blocking_findings: report.blocking_findings,
    unknowns: report.unknowns,
    generated_at: report.completed_at,
    validation_digest: report.run_digest,
  };
}

async function executeRun(profile: ValidationProfile, requestedGate?: string): Promise<void> {
  const policy = await loadValidationPolicy(ROOT);
  const profileDefinition = policy.profiles[profile];
  const requested = requestedGate ? [requestedGate] : profileDefinition.gates;
  const gateOrder = dependencyClosure(requested);
  const repository = await getRepositoryContext(ROOT);
  const environment = await getEnvironmentRecord(ROOT);
  const writer = new EvidenceWriter(ROOT, requestedGate ? `gate-${requestedGate}` : profile, repository.commit_sha);
  await writer.initialize();
  const runStarted = new Date();
  const gateStatuses = new Map<string, ValidationStatus>();
  const evidence: GateEvidence[] = [];
  const allFindings: ValidationFinding[] = [];
  const allUnknowns: ValidationUnknown[] = [];

  for (const gateId of gateOrder) {
    const gate = GATE_BY_ID.get(gateId);
    if (!gate) throw new Error(`Unknown gate after dependency expansion: ${gateId}`);
    const failedDependencies = gate.dependencies.filter((dependency) => {
      const status = gateStatuses.get(dependency);
      return status !== 'PASS' && status !== 'PASS_WITH_FINDINGS';
    });
    const started = new Date();
    const startTick = performance.now();
    let result: GateResult;
    try {
      const context: GateContext = { root: ROOT, profile };
      result = failedDependencies.length > 0
        ? dependencyBlockedResult(gate, failedDependencies)
        : await gate.execute(context);
    } catch (error) {
      result = internalFailureResult(gateId, error);
    }
    const completed = new Date();
    const duration = performance.now() - startTick;
    let artifacts = [...(result.artifacts ?? [])];
    const artifactSources = [...(result.artifact_sources ?? [])];
    try {
      for (const source of artifactSources) {
        artifacts.push(await writer.recordArtifact(source.path, source.media_type));
      }
    } catch (error) {
      result = internalFailureResult(gateId, error);
      artifacts = [];
    } finally {
      for (const source of artifactSources) {
        if (source.cleanup) await rm(source.path, { force: true });
      }
    }
    const stdoutPath = await writer.writeLog(gateId, 'stdout', result.stdout ?? '');
    const stderrPath = await writer.writeLog(gateId, 'stderr', result.stderr ?? '');
    const required = requested.includes(gateId) || profileDefinition.gates.includes(gateId);
    const gateEvidence = await writer.writeGate({
      schema_version: '1.0.0',
      run_id: writer.runId,
      gate_id: gateId,
      gate_class: gate.gateClass,
      profile,
      required,
      status: result.status,
      repository,
      execution: normalizeExecution(result.execution, started.toISOString(), completed.toISOString(), duration),
      environment,
      assertions: result.assertions ?? [],
      findings: result.findings ?? [],
      blocked_by: result.blocked_by ?? [],
      unknowns: result.unknowns ?? [],
      artifacts,
      logs: { stdout_path: stdoutPath, stderr_path: stderrPath, redacted: true },
    });
    gateStatuses.set(gateId, result.status);
    evidence.push(gateEvidence);
    allFindings.push(...gateEvidence.findings.filter((item) => item.blocking));
    allUnknowns.push(...gateEvidence.unknowns);
    console.log(`${gateId}: ${result.status}`);
  }

  const requiredStatuses = evidence.filter((item) => item.required).map((item) => item.status);
  const overallStatus = aggregateStatus(requiredStatuses);
  const completed = new Date();
  const report = await writer.finalize({
    schema_version: '1.0.0',
    policy_version: policy.policy_version,
    run_id: writer.runId,
    profile,
    repository,
    started_at: runStarted.toISOString(),
    completed_at: completed.toISOString(),
    duration_ms: completed.getTime() - runStarted.getTime(),
    overall_status: overallStatus,
    gate_order: gateOrder,
    gates: evidence.map((item) => ({
      gate_id: item.gate_id,
      required: item.required,
      status: item.status,
      evidence_path: path.relative(ROOT, path.join(writer.runDir, `${item.gate_id}.json`)),
      evidence_digest: item.evidence_digest,
    })),
    blocking_findings: allFindings,
    unknowns: allUnknowns,
  });

  if (!requestedGate && (profile === 'release' || profile === 'production')) {
    const receipt = releaseReceipt(report, evidence);
    const receiptWithDigest: ReleaseReceipt = { ...receipt, receipt_digest: sha256(canonicalJson(receipt)) };
    validateReleaseReceipt(receiptWithDigest);
    await mkdir(writer.artifactsDir, { recursive: true });
    await writeFile(path.join(writer.artifactsDir, `${profile}-receipt.json`), canonicalJson(receiptWithDigest), { mode: 0o600 });
  }

  console.log(`Validation run: ${path.relative(ROOT, writer.runDir)}`);
  console.log(`Overall: ${report.overall_status}`);
  if (!isProfilePassing(report.overall_status, profileDefinition)) {
    process.exitCode = report.overall_status === 'PASS_WITH_FINDINGS'
      ? 1
      : exitCodeForStatus(report.overall_status);
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === 'clean') {
    await rm(path.join(ROOT, 'validation', 'runs'), { recursive: true, force: true });
    console.log('Removed generated validation runs.');
    return;
  }
  if (args.gate) {
    await executeRun('ci', args.gate);
    return;
  }
  await executeRun(args.profile ?? 'ci');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 3;
});
