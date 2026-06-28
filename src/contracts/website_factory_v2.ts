/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Website Factory Handoff Contract v2
 *
 * Zod schema for the `seo_contract_v2` handoff payload that the Website Factory
 * (Website-Bot) POSTs to `POST /api/clients/register`. This is the single source
 * of truth for the webhook onboarding contract; Website-Bot mirrors this shape
 * when it emits the handoff.
 *
 * Keep field names aligned with the `clients` table + `config` jsonb so the
 * downstream SEO modules (serp-intelligence, behavior-intelligence, ...) can read
 * `config.targetKeywords`, `config.industry`, `config.city` unchanged.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';

export const KEYWORD_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export const TargetKeyword = z.object({
  keyword: z.string().min(1),
  priority: z.enum(KEYWORD_PRIORITIES),
});

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
  targetKeywords: z.array(TargetKeyword).min(1),
  competitorUrls: z.array(z.string().url()).default([]),
  vercelUrl: z.string().url().optional(),
  seo_contract: z.record(z.unknown()).optional(),
});

export type WebsiteFactoryContractV2 = z.infer<typeof WebsiteFactoryContractV2>;
export type TargetKeyword = z.infer<typeof TargetKeyword>;
