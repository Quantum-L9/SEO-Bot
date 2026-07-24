export const VALIDATION_STATUSES = [
  'PASS',
  'PASS_WITH_FINDINGS',
  'BLOCKED',
  'FAIL',
  'UNKNOWN',
] as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];
export type ValidationProfile = 'ci' | 'release' | 'production';
export type GateClass =
  | 'static'
  | 'build'
  | 'test'
  | 'database'
  | 'container'
  | 'integration'
  | 'operational'
  | 'release';

export type FindingSeverity = 'critical' | 'major' | 'minor' | 'info';
export type AssertionResult = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ValidationAssertion {
  id: string;
  description: string;
  expected: unknown;
  actual: unknown;
  result: AssertionResult;
}

export interface ValidationFinding {
  id: string;
  severity: FindingSeverity;
  message: string;
  owner: string;
  blocking: boolean;
  evidence_refs: string[];
}

export interface ValidationBlocker {
  type: 'credential' | 'service' | 'dependency' | 'approval' | 'environment';
  name: string;
  reason: string;
}

export interface ValidationUnknown {
  id: string;
  description: string;
  required_resolution: string;
}

export interface ArtifactRecord {
  path: string;
  media_type: string;
  sha256: string;
  size_bytes: number;
}

export interface ArtifactSource {
  path: string;
  media_type: string;
  cleanup?: boolean;
}

export interface RepositoryContext {
  name: string;
  commit_sha: string;
  branch: string | null;
  dirty: boolean;
}

export interface ExecutionRecord {
  command: string[];
  cwd: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
}

export interface EnvironmentRecord {
  ci: boolean;
  os: string;
  architecture: string;
  node_version: string;
  npm_version: string;
}

export interface GateEvidence {
  schema_version: '1.0.0';
  run_id: string;
  gate_id: string;
  gate_class: GateClass;
  profile: ValidationProfile;
  required: boolean;
  status: ValidationStatus;
  repository: RepositoryContext;
  execution: ExecutionRecord;
  environment: EnvironmentRecord;
  assertions: ValidationAssertion[];
  findings: ValidationFinding[];
  blocked_by: ValidationBlocker[];
  unknowns: ValidationUnknown[];
  artifacts: ArtifactRecord[];
  logs: {
    stdout_path: string | null;
    stderr_path: string | null;
    redacted: true;
  };
  evidence_digest: string;
}

export interface RunReport {
  schema_version: '1.0.0';
  policy_version: string;
  run_id: string;
  profile: ValidationProfile;
  repository: RepositoryContext;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  overall_status: ValidationStatus;
  gate_order: string[];
  gates: Array<{
    gate_id: string;
    required: boolean;
    status: ValidationStatus;
    evidence_path: string;
    evidence_digest: string;
  }>;
  blocking_findings: ValidationFinding[];
  unknowns: ValidationUnknown[];
  run_digest: string;
}

export interface ReleaseReceipt {
  schema_version: '1.0.0';
  repository: RepositoryContext;
  image: { digest: string | null };
  validation_run_id: string;
  profile: 'release' | 'production';
  overall_status: ValidationStatus;
  required_gates: RunReport['gates'];
  blocking_findings: ValidationFinding[];
  unknowns: ValidationUnknown[];
  generated_at: string;
  validation_digest: string;
  receipt_digest: string;
}

export interface GateResult {
  status: ValidationStatus;
  assertions?: ValidationAssertion[];
  findings?: ValidationFinding[];
  blocked_by?: ValidationBlocker[];
  unknowns?: ValidationUnknown[];
  artifacts?: ArtifactRecord[];
  artifact_sources?: ArtifactSource[];
  execution?: Partial<ExecutionRecord>;
  stdout?: string;
  stderr?: string;
}

export interface ProfileDefinition {
  gates: string[];
  allow_pass_with_findings: boolean;
  blocked_is_failure: boolean;
}

export interface ValidationPolicy {
  schema_version: '1.0.0';
  policy_version: string;
  profiles: Record<ValidationProfile, ProfileDefinition>;
}

const STATUS_PRECEDENCE: Record<ValidationStatus, number> = {
  PASS: 0,
  PASS_WITH_FINDINGS: 1,
  BLOCKED: 2,
  UNKNOWN: 3,
  FAIL: 4,
};

export function aggregateStatus(statuses: ValidationStatus[]): ValidationStatus {
  if (statuses.length === 0) return 'UNKNOWN';
  return statuses.reduce<ValidationStatus>(
    (worst, current) => (STATUS_PRECEDENCE[current] > STATUS_PRECEDENCE[worst] ? current : worst),
    'PASS',
  );
}

export function isProfilePassing(status: ValidationStatus, profile: ProfileDefinition): boolean {
  if (status === 'PASS') return true;
  if (status === 'PASS_WITH_FINDINGS') return profile.allow_pass_with_findings;
  if (status === 'BLOCKED') return !profile.blocked_is_failure;
  return false;
}

export function exitCodeForStatus(status: ValidationStatus): number {
  switch (status) {
    case 'PASS':
    case 'PASS_WITH_FINDINGS':
      return 0;
    case 'FAIL':
      return 1;
    case 'BLOCKED':
      return 2;
    case 'UNKNOWN':
      return 3;
  }
}
