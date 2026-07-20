import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProfileDefinition, ValidationPolicy, ValidationProfile } from './types.js';

function validateProfile(name: ValidationProfile, value: unknown): asserts value is ProfileDefinition {
  if (!value || typeof value !== 'object') throw new Error(`Invalid validation policy: profile ${name} is required`);
  const definition = value as Partial<ProfileDefinition>;
  if (!Array.isArray(definition.gates) || definition.gates.length === 0 || definition.gates.some((gate) => typeof gate !== 'string' || gate.length === 0)) {
    throw new Error(`Invalid validation policy: profile ${name} must define non-empty gate ids`);
  }
  if (new Set(definition.gates).size !== definition.gates.length) {
    throw new Error(`Invalid validation policy: profile ${name} contains duplicate gates`);
  }
  if (typeof definition.allow_pass_with_findings !== 'boolean' || typeof definition.blocked_is_failure !== 'boolean') {
    throw new Error(`Invalid validation policy: profile ${name} must define boolean result policies`);
  }
}

export async function loadValidationPolicy(repositoryRoot: string): Promise<ValidationPolicy> {
  const policyPath = path.join(repositoryRoot, 'validation', 'policy.yaml');
  const text = await readFile(policyPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    throw new Error(`validation/policy.yaml must use JSON-compatible YAML syntax: ${(error as Error).message}`);
  }
  const policy = parsed as Partial<ValidationPolicy>;
  if (policy.schema_version !== '1.0.0' || typeof policy.policy_version !== 'string' || policy.policy_version.length === 0 || !policy.profiles) {
    throw new Error('Invalid validation policy: schema_version, policy_version, and profiles are required');
  }
  for (const profile of ['ci', 'release', 'production'] satisfies ValidationProfile[]) {
    validateProfile(profile, policy.profiles[profile]);
  }
  return policy as ValidationPolicy;
}
