import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRecord, GateEvidence, RunReport, ValidationFinding, ValidationUnknown } from '../types.js';
import { validateGateEvidence, validateRunReport } from './schema-validator.js';
import { redactText } from './redact.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, redactValue(nested)]),
    ) as T;
  }
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value), null, 2) + '\n'; }
export function sha256(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, filePath);
}
function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Refusing to access outside repository root: ${target}`);
}
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || /(?:json|yaml|xml|javascript|typescript)/i.test(mediaType);
}

export class EvidenceWriter {
  readonly runId: string;
  readonly runDir: string;
  readonly logsDir: string;
  readonly artifactsDir: string;

  constructor(
    private readonly repositoryRoot: string,
    profile: string,
    commitSha: string,
    now = new Date(),
  ) {
    const timestamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
    const nonce = randomBytes(3).toString('hex');
    this.runId = `${timestamp}-${commitSha.slice(0, 8)}-${profile}-${nonce}`;
    this.runDir = path.join(repositoryRoot, 'validation', 'runs', this.runId);
    this.logsDir = path.join(this.runDir, 'logs');
    this.artifactsDir = path.join(this.runDir, 'artifacts');
  }

  async initialize(): Promise<void> {
    try { await stat(this.runDir); throw new Error(`Evidence run already exists: ${this.runDir}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(this.logsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
  }
  async writeLog(gateId: string, stream: 'stdout' | 'stderr', content: string): Promise<string | null> {
    if (!content) return null;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(gateId)) throw new Error(`Invalid gate id for log path: ${gateId}`);
    const target = path.join(this.logsDir, `${gateId}.${stream}.log`);
    ensureInside(this.runDir, target);
    await atomicWrite(target, redactText(content));
    return path.relative(this.repositoryRoot, target);
  }
  async recordArtifact(sourcePath: string, mediaType: string): Promise<ArtifactRecord> {
    const repositoryReal = await realpath(this.repositoryRoot);
    const requested = path.isAbsolute(sourcePath) ? sourcePath : path.join(this.repositoryRoot, sourcePath);
    const sourceReal = await realpath(requested);
    ensureInside(repositoryReal, sourceReal);
    let content = await readFile(sourceReal);
    if (isTextMediaType(mediaType)) content = Buffer.from(redactText(content.toString('utf8')), 'utf8');
    const relative = path.relative(repositoryReal, sourceReal).replaceAll(path.sep, '/');
    const destinationName = `${sha256(relative).slice(0, 12)}-${path.basename(relative)}`;
    const destination = path.join(this.artifactsDir, destinationName);
    ensureInside(this.runDir, destination);
    await atomicWrite(destination, content);
    return {
      path: path.relative(this.repositoryRoot, destination),
      media_type: mediaType,
      sha256: sha256(content),
      size_bytes: content.byteLength,
    };
  }
  async writeGate(evidenceWithoutDigest: Omit<GateEvidence, 'evidence_digest'>): Promise<GateEvidence> {
    const redacted = redactValue(evidenceWithoutDigest);
    const evidence: GateEvidence = {
      ...redacted,
      evidence_digest: sha256(canonicalJson(redacted)),
    };
    validateGateEvidence(evidence);
    await atomicWrite(path.join(this.runDir, `${evidence.gate_id}.json`), canonicalJson(evidence));
    await appendFile(path.join(this.runDir, 'evidence.jsonl'), JSON.stringify(evidence) + '\n', {
      encoding: 'utf8', mode: 0o600,
    });
    return evidence;
  }
  async finalize(reportWithoutDigest: Omit<RunReport, 'run_digest'>): Promise<RunReport> {
    const redacted = redactValue(reportWithoutDigest);
    const report: RunReport = {
      ...redacted,
      run_digest: sha256(canonicalJson(redacted)),
    };
    validateRunReport(report);
    await atomicWrite(path.join(this.runDir, 'run.json'), canonicalJson(report));
    await atomicWrite(path.join(this.runDir, 'summary.md'), renderSummary(report));
    return report;
  }
}

function renderSummary(report: RunReport): string {
  const findings: ValidationFinding[] = report.blocking_findings;
  const unknowns: ValidationUnknown[] = report.unknowns;
  const rows = report.gates.map((gate) =>
    `| \`${gate.gate_id}\` | ${gate.required ? 'yes' : 'no'} | **${gate.status}** |`,
  ).join('\n');
  const findingLines = findings.length
    ? findings.map((item) => `- **${item.id}** (${item.severity}): ${item.message}`).join('\n')
    : '- None';
  const unknownLines = unknowns.length
    ? unknowns.map((item) => `- **${item.id}**: ${item.description}`).join('\n')
    : '- None';
  return `# Validation Run ${report.run_id}\n\n` +
    `- Profile: \`${report.profile}\`\n` +
    `- Commit: \`${report.repository.commit_sha}\`\n` +
    `- Overall status: **${report.overall_status}**\n` +
    `- Run digest: \`${report.run_digest}\`\n\n` +
    `## Gates\n\n| Gate | Required | Status |\n|---|---:|---|\n${rows}\n\n` +
    `## Blocking findings\n\n${findingLines}\n\n` +
    `## Unknowns\n\n${unknownLines}\n`;
}
