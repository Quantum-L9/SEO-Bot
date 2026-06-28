import { describe, it, expect } from 'vitest';
import { WebsiteFactoryContractV2 } from '../../src/contracts/website_factory_v2.js';

const valid = {
  schema_version: '2.0',
  domain: 'example.com',
  name: 'Example Co',
  industry: 'roofing',
  targetKeywords: [{ keyword: 'roof repair', priority: 'high' }],
};

describe('WebsiteFactoryContractV2', () => {
  it('accepts a minimal valid payload and defaults competitorUrls to []', () => {
    const result = WebsiteFactoryContractV2.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.competitorUrls).toEqual([]);
  });

  it('accepts a full payload', () => {
    const result = WebsiteFactoryContractV2.safeParse({
      ...valid,
      client_id: 'abc',
      city: 'Austin',
      state: 'TX',
      competitorUrls: ['https://competitor.com'],
      vercelUrl: 'https://example.vercel.app',
      posthog_project_id: 'proj_1',
      posthog_api_key: 'phc_key',
      seo_contract: { baseline: { lcp: 1.2 } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects the wrong schema_version', () => {
    expect(WebsiteFactoryContractV2.safeParse({ ...valid, schema_version: '1.0' }).success).toBe(false);
  });

  it('rejects a missing targetKeywords', () => {
    const { targetKeywords, ...rest } = valid;
    expect(WebsiteFactoryContractV2.safeParse(rest).success).toBe(false);
  });

  it('rejects empty targetKeywords', () => {
    expect(WebsiteFactoryContractV2.safeParse({ ...valid, targetKeywords: [] }).success).toBe(false);
  });

  it('rejects an invalid keyword priority', () => {
    expect(
      WebsiteFactoryContractV2.safeParse({
        ...valid,
        targetKeywords: [{ keyword: 'x', priority: 'urgent' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a state that is not 2 characters', () => {
    expect(WebsiteFactoryContractV2.safeParse({ ...valid, state: 'Texas' }).success).toBe(false);
  });

  it('rejects a non-URL competitorUrls entry', () => {
    expect(WebsiteFactoryContractV2.safeParse({ ...valid, competitorUrls: ['not-a-url'] }).success).toBe(false);
  });
});
