const SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|DATABASE_URL|DEPLOY_HOOK)/i;
const MIN_SECRET_LENGTH = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectSecretValues(environment: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (!value || value.length < MIN_SECRET_LENGTH || !SENSITIVE_NAME.test(name)) continue;
    values.set(name, value);
  }
  return values;
}

export function redactText(input: string, environment: NodeJS.ProcessEnv = process.env): string {
  let output = input;
  output = output.replace(
    /(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
    '$1[REDACTED:AUTHORIZATION]',
  );
  output = output.replace(
    /(\/\/(?:npm\.pkg\.github\.com|registry\.npmjs\.org)\/:_authToken=)[^\s]+/gi,
    '$1[REDACTED:NPM_TOKEN]',
  );
  output = output.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    '$1[REDACTED:URL_USER]:[REDACTED:URL_PASSWORD]@',
  );
  output = output.replace(
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    '[REDACTED:PRIVATE_KEY]',
  );
  for (const [name, value] of collectSecretValues(environment)) {
    output = output.replace(new RegExp(escapeRegExp(value), 'g'), `[REDACTED:${name}]`);
  }
  return output;
}
