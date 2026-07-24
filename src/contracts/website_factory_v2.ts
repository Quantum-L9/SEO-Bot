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
 *
 * ── Enriched v2 (additive, backward compatible) ─────────────────────────────────
 * The optional `site` / `proof` / `integrity` block carries the release-evidence
 * provenance the Website Factory produces once it publishes to a client repo and
 * deploys to Vercel. It stays on `schema_version: '2.0'` — this is NOT a v3 bump.
 * Existing flat-v2 producers omit the block entirely and validate unchanged. When
 * the block is present it enables verified, fail-closed maintenance activation
 * (see maintenance-readiness.ts); when absent the endpoint behaves exactly as it
 * did before (see api/clients/register.ts).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const KEYWORD_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export const TargetKeyword = z.object({
  keyword: z.string().min(1),
  priority: z.enum(KEYWORD_PRIORITIES),
});

// ── Shared validators for the enriched provenance block ─────────────────────────
const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Sha64 = z.string().regex(/^[a-f0-9]{64}$/);
const EnvSecretRef = z.string().regex(/^env:\/\/[A-Z][A-Z0-9_]*$/);

export const SiteRepositoryV2 = z.object({
  provider: z.literal('github'),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repository_id: z.string().min(1).optional(),
  branch: z.string().min(1),
  commit_sha: Sha40,
  source_digest: Sha64,
  managed_manifest_path: z.literal('.l9/generated-manifest.json'),
  editable_root: z.literal('src/pages'),
  page_path_strategy: z.literal('directory-index-astro'),
}).strict();

export const SiteDeploymentV2 = z.object({
  provider: z.literal('vercel'),
  project_id: z.string().min(1),
  deployment_id: z.string().min(1),
  deployment_url: z.string().url(),
  state: z.literal('READY'),
  requested_commit_sha: Sha40,
  observed_commit_sha: Sha40,
}).strict();

export const SiteMaintenanceV2 = z.object({
  enabled: z.literal(true),
  transport: z.literal('github-contents-api'),
  github_credential_ref: EnvSecretRef,
  vercel_deploy_hook_ref: EnvSecretRef.optional(),
  required_paths: z.array(z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/)).min(2),
}).strict();

export const SiteBlockV2 = z.object({
  repository: SiteRepositoryV2,
  deployment: SiteDeploymentV2,
  maintenance: SiteMaintenanceV2,
}).strict();

export const HandoffProofV2 = z.object({
  receipt_id: z.string().min(1),
  receipt_status: z.literal('succeeded'),
  source_digest: Sha64,
  dist_digest: Sha64,
  local_build_status: z.literal('passed'),
  publication_status: z.literal('passed'),
  deployment_status: z.literal('passed'),
}).strict();

export const HandoffIntegrityV2 = z.object({
  algorithm: z.literal('sha256'),
  payload_digest: Sha64,
}).strict();

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
  // Enriched provenance (optional, additive — absent for flat-v2 producers).
  site: SiteBlockV2.optional(),
  proof: HandoffProofV2.optional(),
  integrity: HandoffIntegrityV2.optional(),
}).superRefine((value, ctx) => {
  // Cross-field consistency is enforced ONLY when the enriched block is present,
  // so flat-v2 payloads remain valid. Mirrors the v3 handoff invariants.
  if (!value.site) return;
  const commit = value.site.repository.commit_sha;
  if (value.site.deployment.requested_commit_sha !== commit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'deployment', 'requested_commit_sha'], message: 'must equal repository.commit_sha' });
  }
  if (value.site.deployment.observed_commit_sha !== commit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'deployment', 'observed_commit_sha'], message: 'must equal repository.commit_sha' });
  }
  if (value.proof && value.proof.source_digest !== value.site.repository.source_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proof', 'source_digest'], message: 'must equal repository.source_digest' });
  }
  const required = new Set(value.site.maintenance.required_paths);
  if (required.size !== value.site.maintenance.required_paths.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'maintenance', 'required_paths'], message: 'must contain unique paths' });
  }
  if (!required.has(value.site.repository.managed_manifest_path)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'maintenance', 'required_paths'], message: 'must include managed_manifest_path' });
  }
  if (!required.has('src/pages/index.astro')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'maintenance', 'required_paths'], message: 'must include src/pages/index.astro' });
  }
});

export type WebsiteFactoryContractV2 = z.infer<typeof WebsiteFactoryContractV2>;
export type TargetKeyword = z.infer<typeof TargetKeyword>;
export type SiteBlockV2 = z.infer<typeof SiteBlockV2>;
export type SiteRepositoryV2 = z.infer<typeof SiteRepositoryV2>;
export type SiteDeploymentV2 = z.infer<typeof SiteDeploymentV2>;
export type SiteMaintenanceV2 = z.infer<typeof SiteMaintenanceV2>;
export type HandoffProofV2 = z.infer<typeof HandoffProofV2>;
export type HandoffIntegrityV2 = z.infer<typeof HandoffIntegrityV2>;

/** A v2 contract that carries the enriched provenance block (verified maintenance path). */
export type EnrichedWebsiteFactoryContractV2 = WebsiteFactoryContractV2 & {
  site: SiteBlockV2;
};

/** Type guard: does this payload carry the enriched `site` block? */
export function hasEnrichedSite(
  payload: WebsiteFactoryContractV2,
): payload is EnrichedWebsiteFactoryContractV2 {
  return payload.site !== undefined;
}

// ── Deterministic integrity digest (shared with the Website-Bot emitter) ─────────
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** Digest of the contract payload excluding the `integrity` envelope. */
export function digestContractPayload(contract: WebsiteFactoryContractV2): string {
  const { integrity: _integrity, ...payload } = contract;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Verify the optional integrity digest. Provenance is optional in v2, so a payload
 * with no `integrity` envelope is treated as "not asserted" (returns true) rather
 * than failing — readiness never *requires* the digest.
 */
export function verifyContractIntegrity(contract: WebsiteFactoryContractV2): boolean {
  if (!contract.integrity) return true;
  return digestContractPayload(contract) === contract.integrity.payload_digest;
}
