import {
  aggregateStatus,
  VALIDATION_STATUSES,
  type GateEvidence,
  type ReleaseReceipt,
  type RunReport,
} from '../types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Evidence schema violation: ${message}`);
}
function isSha256(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function isDateTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }

export function validateGateEvidence(value: GateEvidence): void {
  assert(value.schema_version === '1.0.0', 'unsupported gate schema_version');
  assert(value.run_id.length > 0, 'run_id is required');
  assert(/^[a-z0-9][a-z0-9-]*$/.test(value.gate_id), 'gate_id format is invalid');
  assert(VALIDATION_STATUSES.includes(value.status), `invalid status ${value.status}`);
  assert(value.repository.name === 'Quantum-L9/SEO-Bot', 'repository name is invalid');
  assert(/^[a-f0-9]{40}$/.test(value.repository.commit_sha), 'commit_sha must be a full SHA-1');
  assert(typeof value.required === 'boolean', 'required must be boolean');
  assert(Array.isArray(value.execution.command), 'execution.command must be an array');
  assert(isDateTime(value.execution.started_at), 'execution.started_at must be date-time');
  assert(isDateTime(value.execution.completed_at), 'execution.completed_at must be date-time');
  assert(value.execution.duration_ms >= 0, 'execution.duration_ms must be non-negative');
  assert(Array.isArray(value.assertions), 'assertions must be an array');
  assert(Array.isArray(value.findings), 'findings must be an array');
  assert(Array.isArray(value.blocked_by), 'blocked_by must be an array');
  assert(Array.isArray(value.unknowns), 'unknowns must be an array');
  assert(Array.isArray(value.artifacts), 'artifacts must be an array');
  assert(value.artifacts.every((item) => isSha256(item.sha256) && item.size_bytes >= 0), 'artifact records are invalid');
  assert(value.logs.redacted === true, 'logs must be redacted');
  assert(isSha256(value.evidence_digest), 'evidence_digest must be SHA-256');

  const failed = value.assertions.some((item) => item.result === 'FAIL');
  const unknown = value.assertions.some((item) => item.result === 'UNKNOWN');
  const blockingFinding = value.findings.some((item) => item.blocking);

  if (value.status === 'PASS') {
    assert(value.blocked_by.length === 0, 'PASS cannot contain blockers');
    assert(value.unknowns.length === 0, 'PASS cannot contain unknowns');
    assert(!blockingFinding, 'PASS cannot contain blocking findings');
    assert(!failed && !unknown, 'PASS requires all assertions to pass');
  }
  if (value.status === 'PASS_WITH_FINDINGS') {
    assert(value.findings.length > 0, 'PASS_WITH_FINDINGS requires findings');
    assert(value.findings.every((item) => !item.blocking), 'PASS_WITH_FINDINGS cannot contain blocking findings');
    assert(value.blocked_by.length === 0, 'PASS_WITH_FINDINGS cannot contain blockers');
    assert(value.unknowns.length === 0, 'PASS_WITH_FINDINGS cannot contain unknowns');
    assert(!failed && !unknown, 'PASS_WITH_FINDINGS requires all assertions to pass');
  }
  if (value.status === 'BLOCKED') {
    assert(value.blocked_by.length > 0, 'BLOCKED requires blocked_by');
    assert(!failed && !blockingFinding, 'BLOCKED cannot contain executed failures');
  }
  if (value.status === 'UNKNOWN') {
    assert(value.unknowns.length > 0, 'UNKNOWN requires unknowns');
    assert(value.blocked_by.length === 0, 'UNKNOWN cannot contain blockers');
    assert(!failed && !blockingFinding, 'UNKNOWN cannot contain executed failures');
  }
  if (value.status === 'FAIL') {
    assert(failed || blockingFinding, 'FAIL requires a failed assertion or blocking finding');
  }
}

export function validateRunReport(value: RunReport): void {
  assert(value.schema_version === '1.0.0', 'unsupported run schema_version');
  assert(value.policy_version.length > 0, 'policy_version is required');
  assert(value.run_id.length > 0, 'run_id is required');
  assert(VALIDATION_STATUSES.includes(value.overall_status), 'invalid overall_status');
  assert(value.repository.name === 'Quantum-L9/SEO-Bot', 'repository name is invalid');
  assert(/^[a-f0-9]{40}$/.test(value.repository.commit_sha), 'commit_sha must be a full SHA-1');
  assert(isDateTime(value.started_at) && isDateTime(value.completed_at), 'run timestamps must be date-time');
  assert(value.duration_ms >= 0, 'duration_ms must be non-negative');
  assert(value.gate_order.length === value.gates.length, 'gate_order and gates length mismatch');
  assert(new Set(value.gate_order).size === value.gate_order.length, 'gate_order must not contain duplicates');
  assert(value.gates.every((gate, index) => gate.gate_id === value.gate_order[index]), 'gate_order must match gate records');
  assert(value.gates.every((gate) => isSha256(gate.evidence_digest) && gate.evidence_path.length > 0), 'gate evidence references are invalid');
  assert(value.blocking_findings.every((item) => item.blocking), 'blocking_findings must contain only blocking findings');
  const expected = aggregateStatus(value.gates.filter((gate) => gate.required).map((gate) => gate.status));
  assert(value.overall_status === expected, `overall_status must be ${expected}`);
  assert(isSha256(value.run_digest), 'run_digest must be SHA-256');
}

export function validateReleaseReceipt(value: ReleaseReceipt): void {
  assert(value.schema_version === '1.0.0', 'unsupported release receipt schema_version');
  assert(value.profile === 'release' || value.profile === 'production', 'release receipt profile is invalid');
  assert(value.repository.name === 'Quantum-L9/SEO-Bot', 'release receipt repository name is invalid');
  assert(/^[a-f0-9]{40}$/.test(value.repository.commit_sha), 'release receipt commit_sha must be a full SHA-1');
  assert(VALIDATION_STATUSES.includes(value.overall_status), 'release receipt status is invalid');
  assert(value.validation_run_id.length > 0, 'release receipt validation_run_id is required');
  assert(isDateTime(value.generated_at), 'release receipt generated_at must be date-time');
  assert(isSha256(value.validation_digest), 'release receipt validation_digest must be SHA-256');
  assert(isSha256(value.receipt_digest), 'release receipt receipt_digest must be SHA-256');
  assert(value.required_gates.every((gate) => gate.required), 'release receipt must contain only required gates');
  assert(value.blocking_findings.every((item) => item.blocking), 'release receipt findings must be blocking');
  if (value.overall_status === 'PASS' || value.overall_status === 'PASS_WITH_FINDINGS') {
    assert(typeof value.image.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.image.digest),
      'passing release receipt requires a production image digest');
  }
}
