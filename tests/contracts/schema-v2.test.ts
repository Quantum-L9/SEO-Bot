/* L9_META
 * layer: test
 * role: seo_bot_engine
 * status: active
 */

import { describe, expect, it } from 'vitest';
import { WebsiteFactoryContractV2 } from '../../contracts/schema/website_factory_v2.js';

const validPayload = {
  schema_version: '2.0',
  client_id: 'client-123',
  domain: 'example.com',
  name: 'Example Co',
  industry: 'roofing',
  city: 'Austin',
  state: 'TX',
  posthog_project_id: 'ph-project',
  posthog_api_key: 'ph-key',
  targetKeywords: [{ keyword: 'roof repair', priority: 'high' }],
  competitorUrls: ['https://competitor.example.com'],
  vercelUrl: 'https://example.vercel.app',
  seo_contract: { scope: 'full' },
};

describe('WebsiteFactoryContractV2', () => {
  it('passes for a valid full payload', () => {
    const parsed = WebsiteFactoryContractV2.safeParse(validPayload);
    expect(parsed.success).toBe(true);
  });

  it('fails when targetKeywords is missing', () => {
    const parsed = WebsiteFactoryContractV2.safeParse({
      ...validPayload,
      targetKeywords: undefined,
    });

    expect(parsed.success).toBe(false);
  });

  it('fails when targetKeywords is empty', () => {
    const parsed = WebsiteFactoryContractV2.safeParse({
      ...validPayload,
      targetKeywords: [],
    });

    expect(parsed.success).toBe(false);
  });

  it('fails when keyword priority is invalid', () => {
    const parsed = WebsiteFactoryContractV2.safeParse({
      ...validPayload,
      targetKeywords: [{ keyword: 'roof repair', priority: 'urgent' }],
    });

    expect(parsed.success).toBe(false);
  });

  it('fails when schema_version is not 2.0', () => {
    const parsed = WebsiteFactoryContractV2.safeParse({
      ...validPayload,
      schema_version: '1.0',
    });

    expect(parsed.success).toBe(false);
  });

  it('passes when payload has extra fields', () => {
    const parsed = WebsiteFactoryContractV2.safeParse({
      ...validPayload,
      extraField: 'ignored',
    });

    expect(parsed.success).toBe(true);
  });
});
