// L9_META: layer=source, role=tracked_file, status=active, version=1.0.0
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const WEBSITE_FACTORY_HANDOFF_PROTOCOL = 'l9.website-factory.handoff' as const;
export const WEBSITE_FACTORY_HANDOFF_VERSION = '3.0' as const;

const Sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const Sha64 = z.string().regex(/^[a-f0-9]{64}$/);
const EnvSecretRef = z.string().regex(/^env:\/\/[A-Z][A-Z0-9_]*$/);

export const TargetKeywordV3 = z.object({
  keyword: z.string().trim().min(1),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
}).strict();

export const WebsiteFactoryHandoffV3 = z.object({
  protocol: z.literal(WEBSITE_FACTORY_HANDOFF_PROTOCOL),
  schema_version: z.literal(WEBSITE_FACTORY_HANDOFF_VERSION),
  contract_id: z.string().min(8).max(200),
  emitted_at: z.string().datetime(),
  client: z.object({
    id: z.string().min(1),
    domain: z.string().min(3),
    name: z.string().min(1),
    industry: z.string().min(1),
    city: z.string().optional(),
    state: z.string().regex(/^[A-Z]{2}$/).optional(),
  }).strict(),
  seo: z.object({
    target_keywords: z.array(TargetKeywordV3).min(1),
    competitor_urls: z.array(z.string().url()).default([]),
  }).strict(),
  site: z.object({
    repository: z.object({
      provider: z.literal('github'),
      full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      repository_id: z.string().min(1).optional(),
      branch: z.string().min(1),
      commit_sha: Sha40,
      source_digest: Sha64,
      managed_manifest_path: z.literal('.l9/generated-manifest.json'),
      editable_root: z.literal('src/pages'),
      page_path_strategy: z.literal('directory-index-astro'),
    }).strict(),
    deployment: z.object({
      provider: z.literal('vercel'),
      project_id: z.string().min(1),
      deployment_id: z.string().min(1),
      deployment_url: z.string().url(),
      state: z.literal('READY'),
      requested_commit_sha: Sha40,
      observed_commit_sha: Sha40,
    }).strict(),
    maintenance: z.object({
      enabled: z.literal(true),
      transport: z.literal('github-contents-api'),
      github_credential_ref: EnvSecretRef,
      vercel_deploy_hook_ref: EnvSecretRef.optional(),
      required_paths: z.array(z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/)).min(2),
    }).strict(),
  }).strict(),
  proof: z.object({
    receipt_id: z.string().min(1),
    receipt_status: z.literal('succeeded'),
    source_digest: Sha64,
    dist_digest: Sha64,
    local_build_status: z.literal('passed'),
    publication_status: z.literal('passed'),
    deployment_status: z.literal('passed'),
  }).strict(),
  integrity: z.object({
    algorithm: z.literal('sha256'),
    payload_digest: Sha64,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const commit = value.site.repository.commit_sha;
  if (value.site.deployment.requested_commit_sha !== commit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'deployment', 'requested_commit_sha'], message: 'must equal repository.commit_sha' });
  }
  if (value.site.deployment.observed_commit_sha !== commit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['site', 'deployment', 'observed_commit_sha'], message: 'must equal repository.commit_sha' });
  }
  if (value.proof.source_digest !== value.site.repository.source_digest) {
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

export type WebsiteFactoryHandoffV3 = z.infer<typeof WebsiteFactoryHandoffV3>;
export type WebsiteFactoryHandoffPayloadV3 = Omit<WebsiteFactoryHandoffV3, 'integrity'>;

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

export function digestHandoffPayload(payload: WebsiteFactoryHandoffPayloadV3): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function verifyHandoffIntegrity(contract: WebsiteFactoryHandoffV3): boolean {
  const { integrity: _integrity, ...payload } = contract;
  return digestHandoffPayload(payload) === contract.integrity.payload_digest;
}
