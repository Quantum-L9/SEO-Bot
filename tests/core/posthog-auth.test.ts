import { describe, expect, it } from 'vitest';
import {
  isPostHogPersonalApiKey,
  isPostHogProjectApiKey,
  resolvePostHogQueryApiKey,
} from '../../src/core/posthog-auth.js';

describe('posthog-auth', () => {
  it('classifies PostHog key prefixes', () => {
    expect(isPostHogPersonalApiKey('phx_abc')).toBe(true);
    expect(isPostHogProjectApiKey('phc_abc')).toBe(true);
    expect(isPostHogPersonalApiKey('phc_abc')).toBe(false);
  });

  it('prefers per-client personal key for Query API', () => {
    expect(resolvePostHogQueryApiKey('phx_tenant', 'phx_shared')).toBe('phx_tenant');
  });

  it('falls back to shared personal key for project / ingestion keys', () => {
    expect(resolvePostHogQueryApiKey('phc_project', 'phx_shared')).toBe('phx_shared');
    expect(resolvePostHogQueryApiKey(null, 'phx_shared')).toBe('phx_shared');
    expect(resolvePostHogQueryApiKey('  ', 'phx_shared')).toBe('phx_shared');
  });
});
