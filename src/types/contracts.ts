/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Cross-Repo Contract Types
 *
 * GAP-01: Defines the WebsiteFactoryContractV2 Zod schema.
 * This is the machine-readable validator for the handoff payload emitted by
 * Website-Bot's HandoffEmitterStage (schema_version: '2.0.0').
 *
 * Used in:
 *   - src/api/index.ts  → POST /api/clients/register (runtime validation)
 *   - Website-Bot HandoffEmitterStage (same schema, other repo)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';

export const TargetKeywordSchema = z.object({
  keyword: z.string().min(1),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
});

export const WebsiteFactoryContractV2 = z.object({
  schema_version: z.literal('2.0.0'),
  generated_at: z.string().optional(),

  domain: z.string().min(3),

  business: z.object({
    name: z.string().min(1),
    industry: z.string().min(1),
    city: z.string().optional(),
    state: z.string().length(2).optional(),
    country: z.string().length(2).default('US').optional(),
  }),

  seo: z.object({
    targetKeywords: z.array(TargetKeywordSchema).min(1),
    seo_contract: z.object({
      keyword_clusters: z.record(z.string(), z.any()).optional(),
      schema_rules: z.array(z.string()).optional(),
      internal_linking_rules: z.any().optional(),
      guards: z.record(z.string(), z.any()).optional(),
    }).optional(),
    baseline_ranks: z.record(z.string(), z.number().nullable()).optional(),
    schemas_generated: z.array(z.string()).optional(),
    pages_with_content: z.number().int().nonnegative().optional(),
  }),

  analytics: z.object({
    posthog_project_id: z.string().optional(),
    posthog_api_key: z.string().optional(),
    events_instrumented: z.array(z.string()).optional(),
  }).optional(),

  deployment: z.object({
    vercel_url: z.string().url().optional(),
    deployment_id: z.string().optional(),
    source_repo: z.string().optional(),
    source_branch: z.string().optional(),
  }).optional(),
});

export type WebsiteFactoryContractV2Type = z.infer<typeof WebsiteFactoryContractV2>;
export type TargetKeyword = z.infer<typeof TargetKeywordSchema>;
