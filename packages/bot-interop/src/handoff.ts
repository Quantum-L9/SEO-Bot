import { createHash } from "node:crypto";

export const WEBSITE_FACTORY_HANDOFF_PROTOCOL = "l9.website-factory.handoff" as const;
export const WEBSITE_FACTORY_HANDOFF_VERSION = "3.0" as const;
export const DEFAULT_MANAGED_MANIFEST_PATH = ".l9/generated-manifest.json";
export const DEFAULT_REQUIRED_PATHS = [
  DEFAULT_MANAGED_MANIFEST_PATH,
  "src/pages/index.astro",
] as const;

export type KeywordPriority = "critical" | "high" | "medium" | "low";

export interface WebsiteFactoryHandoffV3 {
  protocol: typeof WEBSITE_FACTORY_HANDOFF_PROTOCOL;
  schema_version: typeof WEBSITE_FACTORY_HANDOFF_VERSION;
  contract_id: string;
  emitted_at: string;
  client: {
    id: string;
    domain: string;
    name: string;
    industry: string;
    city?: string;
    state?: string;
  };
  seo: {
    target_keywords: Array<{ keyword: string; priority: KeywordPriority }>;
    competitor_urls: string[];
  };
  site: {
    repository: {
      provider: "github";
      full_name: string;
      repository_id?: string;
      branch: string;
      commit_sha: string;
      source_digest: string;
      managed_manifest_path: string;
      editable_root: "src/pages";
      page_path_strategy: "directory-index-astro";
    };
    deployment: {
      provider: "vercel";
      project_id: string;
      deployment_id: string;
      deployment_url: string;
      state: "READY";
      requested_commit_sha: string;
      observed_commit_sha: string;
    };
    maintenance: {
      enabled: true;
      transport: "github-contents-api";
      github_credential_ref: string;
      vercel_deploy_hook_ref?: string;
      required_paths: string[];
    };
  };
  proof: {
    receipt_id: string;
    receipt_status: "succeeded";
    source_digest: string;
    dist_digest: string;
    local_build_status: "passed";
    publication_status: "passed";
    deployment_status: "passed";
  };
  integrity: {
    algorithm: "sha256";
    payload_digest: string;
  };
}

export type WebsiteFactoryHandoffPayload = Omit<WebsiteFactoryHandoffV3, "integrity">;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_REFERENCE = /^env:\/\/[A-Z][A-Z0-9_]*$/;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
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

export function digestHandoffPayload(payload: WebsiteFactoryHandoffPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function sealWebsiteFactoryHandoff(
  payload: WebsiteFactoryHandoffPayload,
): WebsiteFactoryHandoffV3 {
  const contract: WebsiteFactoryHandoffV3 = {
    ...payload,
    integrity: { algorithm: "sha256", payload_digest: digestHandoffPayload(payload) },
  };
  assertWebsiteFactoryHandoffV3(contract);
  return contract;
}

function assertHandoffIdentity(contract: WebsiteFactoryHandoffV3): void {
  if (
    contract.protocol !== WEBSITE_FACTORY_HANDOFF_PROTOCOL ||
    contract.schema_version !== WEBSITE_FACTORY_HANDOFF_VERSION
  ) {
    throw new Error("unsupported handoff protocol or version");
  }
  if (
    !contract.contract_id ||
    !contract.client?.id ||
    !contract.client?.domain ||
    !contract.client?.name ||
    !contract.client?.industry
  ) {
    throw new Error("handoff identity is incomplete");
  }
  if (Number.isNaN(Date.parse(contract.emitted_at)))
    throw new Error("emitted_at must be an ISO timestamp");
  try {
    new URL(`https://${contract.client.domain}`);
  } catch {
    throw new Error("client.domain is invalid");
  }
}

function assertHandoffSeo(contract: WebsiteFactoryHandoffV3): void {
  if (
    !Array.isArray(contract.seo?.target_keywords) ||
    contract.seo.target_keywords.length === 0 ||
    contract.seo.target_keywords.some((item) => !item.keyword?.trim())
  ) {
    throw new Error("seo.target_keywords must contain at least one non-empty keyword");
  }
  if (!Array.isArray(contract.seo.competitor_urls))
    throw new Error("seo.competitor_urls must be an array");
  for (const url of contract.seo.competitor_urls) {
    try {
      new URL(url);
    } catch {
      throw new Error("seo.competitor_urls contains an invalid URL");
    }
  }
}

function assertHandoffSite(contract: WebsiteFactoryHandoffV3): void {
  if (!REPOSITORY.test(contract.site?.repository?.full_name ?? ""))
    throw new Error("site.repository.full_name must be owner/repo");
  if (!SHA1.test(contract.site.repository.commit_sha))
    throw new Error("site.repository.commit_sha must be a lowercase 40-character SHA");
  if (
    !SHA256.test(contract.site.repository.source_digest) ||
    !SHA256.test(contract.proof?.source_digest ?? "") ||
    !SHA256.test(contract.proof?.dist_digest ?? "")
  ) {
    throw new Error("handoff digests must be lowercase SHA-256 hex");
  }
  if (!ENV_REFERENCE.test(contract.site.maintenance.github_credential_ref))
    throw new Error("github_credential_ref must be env://NAME");
  if (
    contract.site.maintenance.vercel_deploy_hook_ref &&
    !ENV_REFERENCE.test(contract.site.maintenance.vercel_deploy_hook_ref)
  ) {
    throw new Error("vercel_deploy_hook_ref must be env://NAME");
  }
  if (
    contract.site.repository.commit_sha !== contract.site.deployment.requested_commit_sha ||
    contract.site.repository.commit_sha !== contract.site.deployment.observed_commit_sha
  ) {
    throw new Error("publication and deployment commit identities do not match");
  }
  if (contract.site.repository.source_digest !== contract.proof.source_digest)
    throw new Error("repository and proof source digests do not match");
  if (
    contract.site.maintenance.enabled !== true ||
    contract.site.maintenance.transport !== "github-contents-api"
  ) {
    throw new Error("maintenance contract is invalid");
  }
  if (!Array.isArray(contract.site.maintenance.required_paths))
    throw new Error("maintenance.required_paths must be an array");
  const requiredPaths = new Set(contract.site.maintenance.required_paths);
  if (
    requiredPaths.size !== contract.site.maintenance.required_paths.length ||
    !DEFAULT_REQUIRED_PATHS.every((path) => requiredPaths.has(path))
  ) {
    throw new Error(
      "maintenance.required_paths must uniquely include the canonical manifest and Astro home page",
    );
  }
}

function assertHandoffProofAndIntegrity(contract: WebsiteFactoryHandoffV3): void {
  if (
    contract.proof.receipt_status !== "succeeded" ||
    contract.proof.local_build_status !== "passed" ||
    contract.proof.publication_status !== "passed" ||
    contract.proof.deployment_status !== "passed"
  ) {
    throw new Error("handoff proof is incomplete");
  }
  const { integrity, ...payload } = contract;
  if (integrity.algorithm !== "sha256" || !SHA256.test(integrity.payload_digest))
    throw new Error("handoff integrity envelope is invalid");
  if (digestHandoffPayload(payload) !== integrity.payload_digest)
    throw new Error("handoff payload digest mismatch");
}

export function assertWebsiteFactoryHandoffV3(
  value: unknown,
): asserts value is WebsiteFactoryHandoffV3 {
  if (!value || typeof value !== "object") throw new Error("handoff must be an object");
  const contract = value as WebsiteFactoryHandoffV3;
  assertHandoffIdentity(contract);
  assertHandoffSeo(contract);
  assertHandoffSite(contract);
  assertHandoffProofAndIntegrity(contract);
}
