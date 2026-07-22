// L9_META: layer=source, role=tracked_file, status=active, version=1.0.0
export const ENV_SECRET_REF = /^env:\/\/([A-Z][A-Z0-9_]*)$/;

export interface SecretResolution {
  ref: string;
  key: string;
  value: string;
}

export class SecretReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretReferenceError';
  }
}

/**
 * Resolve an env://NAME reference. Infisical already hydrates process.env at boot,
 * so this supports both native environment variables and Infisical without storing
 * secret values in clients.config JSONB or sending them through the handoff payload.
 */
export function resolveSecretRef(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): SecretResolution | undefined {
  if (!ref) return undefined;
  const match = ENV_SECRET_REF.exec(ref);
  if (!match) throw new SecretReferenceError(`Unsupported secret reference: ${ref}`);
  const key = match[1];
  const value = env[key];
  if (!value?.trim()) throw new SecretReferenceError(`Secret reference ${ref} is unresolved`);
  return { ref, key, value };
}
