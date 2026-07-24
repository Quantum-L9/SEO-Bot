import { describe, it, expect } from 'vitest';
import {
  WebsiteFactoryContractV2,
  hasEnrichedSite,
  digestContractPayload,
  verifyContractIntegrity,
} from '../../src/contracts/website_factory_v2.js';

const flat = {
  schema_version: '2.0',
  domain: 'example.com',
  name: 'Example Co',
  industry: 'roofing',
  targetKeywords: [{ keyword: 'roof repair', priority: 'high' }],
};

const commit = 'a'.repeat(40);
const sourceDigest = 'b'.repeat(64);

const enrichedBase = {
  ...flat,
  vercelUrl: 'https://example.vercel.app',
  site: {
    repository: {
      provider: 'github',
      full_name: 'quantum-l9/client-example',
      branch: 'main',
      commit_sha: commit,
      source_digest: sourceDigest,
      managed_manifest_path: '.l9/generated-manifest.json',
      editable_root: 'src/pages',
      page_path_strategy: 'directory-index-astro',
    },
    deployment: {
      provider: 'vercel',
      project_id: 'prj_1',
      deployment_id: 'dpl_1',
      deployment_url: 'https://example.vercel.app',
      state: 'READY',
      requested_commit_sha: commit,
      observed_commit_sha: commit,
    },
    maintenance: {
      enabled: true,
      transport: 'github-contents-api',
      github_credential_ref: 'env://CLIENT_SITE_GITHUB_TOKEN',
      required_paths: ['.l9/generated-manifest.json', 'src/pages/index.astro'],
    },
  },
  proof: {
    receipt_id: 'rcpt_1',
    receipt_status: 'succeeded',
    source_digest: sourceDigest,
    dist_digest: 'c'.repeat(64),
    local_build_status: 'passed',
    publication_status: 'passed',
    deployment_status: 'passed',
  },
};

describe('WebsiteFactoryContractV2 — enriched provenance (additive)', () => {
  it('flat v2 (no site block) still validates and hasEnrichedSite is false', () => {
    const result = WebsiteFactoryContractV2.safeParse(flat);
    expect(result.success).toBe(true);
    if (result.success) expect(hasEnrichedSite(result.data)).toBe(false);
  });

  it('accepts a well-formed enriched payload and hasEnrichedSite is true', () => {
    const result = WebsiteFactoryContractV2.safeParse(enrichedBase);
    expect(result.success).toBe(true);
    if (result.success) expect(hasEnrichedSite(result.data)).toBe(true);
  });

  it('rejects when deployment.requested_commit_sha != repository.commit_sha', () => {
    const bad = structuredClone(enrichedBase);
    bad.site.deployment.requested_commit_sha = 'd'.repeat(40);
    expect(WebsiteFactoryContractV2.safeParse(bad).success).toBe(false);
  });

  it('rejects when proof.source_digest != repository.source_digest', () => {
    const bad = structuredClone(enrichedBase);
    bad.proof.source_digest = 'e'.repeat(64);
    expect(WebsiteFactoryContractV2.safeParse(bad).success).toBe(false);
  });

  it('rejects required_paths missing src/pages/index.astro', () => {
    const bad = structuredClone(enrichedBase);
    bad.site.maintenance.required_paths = ['.l9/generated-manifest.json', 'src/pages/about.astro'];
    expect(WebsiteFactoryContractV2.safeParse(bad).success).toBe(false);
  });

  it('rejects a raw (non env://) github_credential_ref', () => {
    const bad = structuredClone(enrichedBase);
    bad.site.maintenance.github_credential_ref = 'ghp_rawtoken';
    expect(WebsiteFactoryContractV2.safeParse(bad).success).toBe(false);
  });

  it('verifyContractIntegrity: true when digest matches, false when tampered', () => {
    const parsed = WebsiteFactoryContractV2.parse(enrichedBase);
    const withIntegrity = {
      ...parsed,
      integrity: { algorithm: 'sha256' as const, payload_digest: digestContractPayload(parsed) },
    };
    const good = WebsiteFactoryContractV2.parse(withIntegrity);
    expect(verifyContractIntegrity(good)).toBe(true);

    const tampered = WebsiteFactoryContractV2.parse({ ...withIntegrity, name: 'Renamed Co' });
    expect(verifyContractIntegrity(tampered)).toBe(false);
  });

  it('verifyContractIntegrity: true when no integrity envelope is asserted', () => {
    const parsed = WebsiteFactoryContractV2.parse(enrichedBase);
    expect(verifyContractIntegrity(parsed)).toBe(true);
  });
});
