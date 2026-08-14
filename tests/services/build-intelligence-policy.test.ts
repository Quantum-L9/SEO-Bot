/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Routing enforcement THROUGH the real @quantum-l9/llm-router (not a mock of our
 * own policy): the reasoning/generation/validation operations must NEVER resolve
 * to a Perplexity/search route, and FRESH_WEB_EVIDENCE MUST resolve to a
 * search-capable route. This proves the requiresSearch flags in the policy
 * actually steer the router, closing the "research TaskType implies provider"
 * leak.
 */

import { describe, it, expect } from 'vitest';
import { resolveRoute, Provider } from '@quantum-l9/llm-router';
import {
  seoImproveTask,
  assertSeoImprovePolicy,
  type SeoImproveLlmOperation,
} from '../../src/services/improve-llm-policy.js';

const NON_SEARCH_OPS: SeoImproveLlmOperation[] = [
  'SEO_GAP_EXTRACTION',
  'SEO_CONTENT_BLUEPRINT',
  'STRUCTURED_CONTENT_GENERATION',
  'CONTENT_VALIDATION',
];

describe('build-intelligence routing enforcement (real LLM-Router)', () => {
  it('reasoning/generation/validation ops never resolve to a Perplexity/search route', () => {
    for (const op of NON_SEARCH_OPS) {
      const decision = resolveRoute(seoImproveTask(op, 'client-1', `[build-intelligence] ${op}`));
      expect(decision.provider).not.toBe(Provider.PERPLEXITY);
      expect(decision.provider).toBe(Provider.OPENROUTER);
    }
  });

  it('FRESH_WEB_EVIDENCE resolves to a search-capable (Perplexity) route', () => {
    const decision = resolveRoute(seoImproveTask('FRESH_WEB_EVIDENCE', 'client-1', '[build-intelligence] evidence'));
    expect(decision.provider).toBe(Provider.PERPLEXITY);
  });

  it('the shipped policy passes its fail-closed invariant', () => {
    expect(() => assertSeoImprovePolicy()).not.toThrow();
  });
});
