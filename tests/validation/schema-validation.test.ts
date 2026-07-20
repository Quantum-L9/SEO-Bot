import { describe, expect, it } from 'vitest';
import {
  validateGateEvidence,
  validateReleaseReceipt,
  validateRunReport,
} from '../../scripts/validation/core/schema-validator.js';
import type { GateEvidence, ReleaseReceipt, RunReport } from '../../scripts/validation/types.js';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
function evidence(): GateEvidence {
  return {
    schema_version: '1.0.0', run_id: 'run', gate_id: 'test', gate_class: 'test', profile: 'ci', required: true,
    status: 'PASS', repository: { name: 'Quantum-L9/SEO-Bot', commit_sha: sha, branch: 'main', dirty: false },
    execution: { command: ['npm', 'test'], cwd: '.', started_at: new Date(0).toISOString(), completed_at: new Date(1).toISOString(), duration_ms: 1, exit_code: 0, signal: null },
    environment: { ci: true, os: 'linux', architecture: 'x64', node_version: 'v22.0.0', npm_version: '10.0.0' },
    assertions: [{ id: 'test.exit', description: 'passes', expected: 0, actual: 0, result: 'PASS' }],
    findings: [], blocked_by: [], unknowns: [], artifacts: [],
    logs: { stdout_path: null, stderr_path: null, redacted: true }, evidence_digest: digest,
  };
}

describe('evidence schema validation', () => {
  it('accepts a complete PASS gate', () => expect(() => validateGateEvidence(evidence())).not.toThrow());
  it('rejects PASS with an unknown assertion', () => {
    const value = evidence();
    value.assertions[0].result = 'UNKNOWN';
    expect(() => validateGateEvidence(value)).toThrow(/PASS requires all assertions/);
  });
  it('rejects PASS with a blocking finding', () => {
    const value = evidence();
    value.findings.push({ id: 'f', severity: 'major', message: 'blocked', owner: 'test', blocking: true, evidence_refs: [] });
    expect(() => validateGateEvidence(value)).toThrow(/PASS cannot contain blocking findings/);
  });
  it('rejects BLOCKED without an external blocker', () => {
    const value = evidence();
    value.status = 'BLOCKED';
    value.assertions[0].result = 'UNKNOWN';
    expect(() => validateGateEvidence(value)).toThrow(/BLOCKED requires blocked_by/);
  });
  it('rejects non-canonical commit identifiers', () => {
    const value = evidence();
    value.repository.commit_sha = 'UNKNOWN';
    expect(() => validateGateEvidence(value)).toThrow(/commit_sha/);
  });
  it('rejects a run whose overall status does not aggregate its required gates', () => {
    const report: RunReport = {
      schema_version: '1.0.0', policy_version: '1.0.0', run_id: 'run', profile: 'ci',
      repository: evidence().repository, started_at: new Date(0).toISOString(), completed_at: new Date(1).toISOString(),
      duration_ms: 1, overall_status: 'PASS', gate_order: ['test'],
      gates: [{ gate_id: 'test', required: true, status: 'FAIL', evidence_path: 'test.json', evidence_digest: digest }],
      blocking_findings: [], unknowns: [], run_digest: digest,
    };
    expect(() => validateRunReport(report)).toThrow(/overall_status must be FAIL/);
  });

  it('requires an image digest for a passing release receipt', () => {
    const receipt: ReleaseReceipt = {
      schema_version: '1.0.0', repository: evidence().repository, image: { digest: null },
      validation_run_id: 'run', profile: 'release', overall_status: 'PASS',
      required_gates: [{ gate_id: 'container', required: true, status: 'PASS', evidence_path: 'container.json', evidence_digest: digest }],
      blocking_findings: [], unknowns: [], generated_at: new Date(1).toISOString(),
      validation_digest: digest, receipt_digest: digest,
    };
    expect(() => validateReleaseReceipt(receipt)).toThrow(/image digest/);
  });
});
