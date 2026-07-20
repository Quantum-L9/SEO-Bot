import { describe, expect, it } from 'vitest';
import { redactText } from '../../scripts/validation/core/redact.js';

describe('redactText', () => {
  it('redacts named secret values and authorization headers', () => {
    const env = { NODE_AUTH_TOKEN: 'abcdefgh-secret-token' };
    const value = redactText('Authorization: Bearer abcdefgh-secret-token\ntoken=abcdefgh-secret-token', env);
    expect(value).not.toContain('abcdefgh-secret-token');
    expect(value).toContain('[REDACTED:AUTHORIZATION]');
  });

  it('redacts credentials embedded in URLs and private keys', () => {
    const value = redactText(
      'postgres://user:password@db.example/test\n-----BEGIN TEST PRIVATE KEY-----\nabc\n-----END TEST PRIVATE KEY-----',
      {},
    );
    expect(value).toContain('[REDACTED:URL_PASSWORD]');
    expect(value).toContain('[REDACTED:PRIVATE_KEY]');
    expect(value).not.toContain('password@');
  });
});
