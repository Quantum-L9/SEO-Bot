import { describe, it, expect, vi } from 'vitest';

// dashboard.ts pulls in db + logger at import; stub them so we can unit-test the
// pure escapeHtml helper without a database or config.
vi.mock('../../src/core/database/index.js', () => ({ getDb: () => ({}), schema: {} }));
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { escapeHtml } from '../../src/api/dashboard.js';

describe('escapeHtml', () => {
  it('neutralizes a script/img injection payload', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders null/undefined as an empty string and passes numbers through', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});
