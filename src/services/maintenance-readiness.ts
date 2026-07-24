import type { EnrichedWebsiteFactoryContractV2 } from '../contracts/website_factory_v2.js';
import { resolveSecretRef, SecretReferenceError } from './secret-ref.js';

/**
 * Maintenance readiness verification.
 *
 * Runs only for enriched v2 handoffs (those carrying the `site` block). It probes
 * GitHub with the client's env://-referenced credential to confirm the client repo,
 * branch head commit, and required managed/editable paths match the handoff before
 * SEO-Bot activates maintenance. Fail-closed: any mismatch throws and the caller
 * registers the client maintenance-inactive. Field paths are identical to the v3
 * handoff — only the contract TYPE changed (no wire v3).
 */

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export interface MaintenanceProbe {
  name: 'credential' | 'repository' | 'branch_head' | 'managed_manifest' | 'editable_home' | 'required_path' | 'deploy_hook';
  ok: boolean;
  detail?: string;
}

export interface MaintenanceReadinessResult {
  ready: boolean;
  verifiedAt: string;
  verifiedCommitSha: string;
  githubCredentialRef: string;
  vercelDeployHookRef?: string;
  probes: MaintenanceProbe[];
}

export class MaintenanceReadinessError extends Error {
  constructor(
    message: string,
    readonly probes: MaintenanceProbe[],
    readonly code: 'SECRET_UNRESOLVED' | 'REPOSITORY_NOT_FOUND' | 'REPOSITORY_ID_MISMATCH' | 'BRANCH_NOT_FOUND' | 'COMMIT_MISMATCH' | 'REQUIRED_PATH_MISSING' | 'GITHUB_PROBE_FAILED',
  ) {
    super(message);
    this.name = 'MaintenanceReadinessError';
  }
}

export interface MaintenanceReadinessDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function branchRefPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

async function githubGet(fetchImpl: typeof fetch, url: string, token: string): Promise<Response> {
  return fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function failed(probes: MaintenanceProbe[], code: MaintenanceReadinessError['code'], message: string): never {
  throw new MaintenanceReadinessError(message, probes, code);
}

export async function verifyMaintenanceReadiness(
  contract: EnrichedWebsiteFactoryContractV2,
  deps: MaintenanceReadinessDeps = {},
): Promise<MaintenanceReadinessResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const probes: MaintenanceProbe[] = [];

  let githubToken: string;
  try {
    githubToken = resolveSecretRef(contract.site.maintenance.github_credential_ref, env)?.value ?? '';
    probes.push({ name: 'credential', ok: true, detail: contract.site.maintenance.github_credential_ref });
  } catch (error) {
    probes.push({ name: 'credential', ok: false, detail: error instanceof Error ? error.message : String(error) });
    failed(probes, 'SECRET_UNRESOLVED', probes.at(-1)?.detail ?? 'GitHub credential unresolved');
  }

  if (contract.site.maintenance.vercel_deploy_hook_ref) {
    try {
      resolveSecretRef(contract.site.maintenance.vercel_deploy_hook_ref, env);
      probes.push({ name: 'deploy_hook', ok: true, detail: contract.site.maintenance.vercel_deploy_hook_ref });
    } catch (error) {
      probes.push({ name: 'deploy_hook', ok: false, detail: error instanceof Error ? error.message : String(error) });
      if (error instanceof SecretReferenceError) failed(probes, 'SECRET_UNRESOLVED', error.message);
      throw error;
    }
  }

  const repo = contract.site.repository;
  try {
    const repoResponse = await githubGet(fetchImpl, `${GITHUB_API}/repos/${repo.full_name}`, githubToken);
    if (repoResponse.status === 404) {
      probes.push({ name: 'repository', ok: false, detail: `${repo.full_name} not found or token lacks access` });
      failed(probes, 'REPOSITORY_NOT_FOUND', probes.at(-1)?.detail ?? 'Repository unavailable');
    }
    if (!repoResponse.ok) {
      probes.push({ name: 'repository', ok: false, detail: `GitHub returned ${repoResponse.status}` });
      failed(probes, 'GITHUB_PROBE_FAILED', probes.at(-1)?.detail ?? 'Repository probe failed');
    }
    const repoBody = await repoResponse.json() as { id?: number | string; full_name?: string };
    if (repo.repository_id && String(repoBody.id ?? '') !== repo.repository_id) {
      probes.push({ name: 'repository', ok: false, detail: `expected id ${repo.repository_id}, observed ${String(repoBody.id ?? '')}` });
      failed(probes, 'REPOSITORY_ID_MISMATCH', probes.at(-1)?.detail ?? 'Repository id mismatch');
    }
    probes.push({ name: 'repository', ok: true, detail: String(repoBody.full_name ?? repo.full_name) });

    const refResponse = await githubGet(fetchImpl, `${GITHUB_API}/repos/${repo.full_name}/git/ref/heads/${branchRefPath(repo.branch)}`, githubToken);
    if (refResponse.status === 404) {
      probes.push({ name: 'branch_head', ok: false, detail: `branch ${repo.branch} not found` });
      failed(probes, 'BRANCH_NOT_FOUND', probes.at(-1)?.detail ?? 'Branch unavailable');
    }
    if (!refResponse.ok) {
      probes.push({ name: 'branch_head', ok: false, detail: `GitHub returned ${refResponse.status}` });
      failed(probes, 'GITHUB_PROBE_FAILED', probes.at(-1)?.detail ?? 'Branch probe failed');
    }
    const refBody = await refResponse.json() as { object?: { sha?: string } };
    const observedHead = refBody.object?.sha ?? '';
    if (observedHead !== repo.commit_sha) {
      probes.push({ name: 'branch_head', ok: false, detail: `expected ${repo.commit_sha}, observed ${observedHead || 'UNKNOWN'}` });
      failed(probes, 'COMMIT_MISMATCH', probes.at(-1)?.detail ?? 'Branch head mismatch');
    }
    probes.push({ name: 'branch_head', ok: true, detail: observedHead });

    for (const path of contract.site.maintenance.required_paths) {
      const name: MaintenanceProbe['name'] = path === repo.managed_manifest_path
        ? 'managed_manifest'
        : path === 'src/pages/index.astro'
          ? 'editable_home'
          : 'required_path';
      const response = await githubGet(
        fetchImpl,
        `${GITHUB_API}/repos/${repo.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${repo.commit_sha}`,
        githubToken,
      );
      if (!response.ok) {
        probes.push({ name, ok: false, detail: `${path} missing at ${repo.commit_sha}` });
        failed(probes, 'REQUIRED_PATH_MISSING', probes.at(-1)?.detail ?? 'Required path missing');
      }
      probes.push({ name, ok: true, detail: path });
    }
  } catch (error) {
    if (error instanceof MaintenanceReadinessError) throw error;
    probes.push({ name: 'repository', ok: false, detail: error instanceof Error ? error.message : String(error) });
    failed(probes, 'GITHUB_PROBE_FAILED', probes.at(-1)?.detail ?? 'GitHub probe failed');
  }

  return {
    ready: true,
    verifiedAt: (deps.now ?? (() => new Date()))().toISOString(),
    verifiedCommitSha: repo.commit_sha,
    githubCredentialRef: contract.site.maintenance.github_credential_ref,
    ...(contract.site.maintenance.vercel_deploy_hook_ref ? { vercelDeployHookRef: contract.site.maintenance.vercel_deploy_hook_ref } : {}),
    probes,
  };
}
