import { resolveSecretRef } from './secret-ref.js';

/**
 * Resolve the persisted, non-secret v2 deployment provenance (stored in
 * `clients.config.site_deployment` by the enriched-v2 registration path) into
 * runtime credentials for the maintenance transport.
 *
 * v2-locked: the canonical marker is `schemaVersion === '2.0'` + `status === 'ready'`.
 * Raw credentials are never read — only env:// references are resolved — so a
 * mis-provisioned or unverified client is forced to dry-run (fail-closed).
 */

export interface ResolvedSiteDeploymentConfig {
  githubToken: string;
  vercelDeployHook: string;
  websiteBotRepo: string;
  sourceBranch: string;
  dryRun: boolean;
}

interface CanonicalStoredSiteDeployment {
  schemaVersion?: string;
  status?: string;
  githubCredentialRef?: string;
  vercelDeployHookRef?: string;
  websiteBotRepo?: string;
  sourceBranch?: string;
  verifiedCommitSha?: string;
  sourceDigest?: string;
  contractId?: string;
  contractDigest?: string;
  verifiedAt?: string;
  managedManifestPath?: string;
  editableRoot?: string;
  pagePathStrategy?: string;
}

export function siteConfigFromStoredClient(
  clientConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSiteDeploymentConfig {
  const sd = (clientConfig as { site_deployment?: CanonicalStoredSiteDeployment } | undefined)?.site_deployment;
  const canonicalReady = sd?.schemaVersion === '2.0' && sd.status === 'ready';

  let githubToken = '';
  let vercelDeployHook = '';
  if (canonicalReady) {
    try { githubToken = resolveSecretRef(sd.githubCredentialRef, env)?.value ?? ''; } catch { githubToken = ''; }
    try { vercelDeployHook = resolveSecretRef(sd.vercelDeployHookRef, env)?.value ?? ''; } catch { vercelDeployHook = ''; }
  }

  const websiteBotRepo = sd?.websiteBotRepo?.trim() ?? '';
  const sourceBranch = sd?.sourceBranch?.trim() || 'main';
  const contractComplete = canonicalReady
    && /^[a-f0-9]{40}$/.test(sd?.verifiedCommitSha ?? '')
    && /^[a-f0-9]{64}$/.test(sd?.sourceDigest ?? '')
    && Boolean(sd?.contractId)
    && /^[a-f0-9]{64}$/.test(sd?.contractDigest ?? '')
    && Boolean(sd?.verifiedAt && !Number.isNaN(Date.parse(sd.verifiedAt)))
    && sd?.managedManifestPath === '.l9/generated-manifest.json'
    && sd?.editableRoot === 'src/pages'
    && sd?.pagePathStrategy === 'directory-index-astro';

  return {
    githubToken,
    vercelDeployHook,
    websiteBotRepo,
    sourceBranch,
    dryRun:
      env.NODE_ENV === 'test'
      || env.SITE_DEPLOY_DRY_RUN === 'true'
      || !contractComplete
      || !githubToken
      || !websiteBotRepo,
  };
}
