/* L9_META
 * layer: contract
 * role: seo_bot_engine
 * status: active
 */

import { z } from 'zod';

export const WebsiteFactoryContractV2 = z.object({
  schema_version: z.literal('2.0'),
  client_id: z.string().optional(),
  domain: z.string().min(3),
  name: z.string().min(1),
  industry: z.string().min(1),
  city: z.string().optional(),
  state: z.string().length(2).optional(),
  posthog_project_id: z.string().optional(),
  posthog_api_key: z.string().optional(),
  targetKeywords: z.array(z.object({
    keyword: z.string(),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
  })).min(1),
  competitorUrls: z.array(z.string().url()).default([]),
  vercelUrl: z.string().url().optional(),
  seo_contract: z.record(z.unknown()).optional(),
});

export type WebsiteFactoryContractV2 = z.infer<typeof WebsiteFactoryContractV2>;
