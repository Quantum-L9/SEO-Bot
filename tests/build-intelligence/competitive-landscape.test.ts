/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, it, expect, vi } from 'vitest';
import { assertIntelligenceArtifactIntegrity } from '@quantum-l9/bot-interop';
import {
  createCompetitiveLandscape,
  CompetitiveEvidenceIncompleteError,
  type CompetitiveLandscapeRequest,
  type DataForSeoOrganicPort,
} from '../../src/build-intelligence/competitive-landscape.js';
import type { OrganicSerpResult } from '../../src/services/dataforseo.js';

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Zero-LLM guard: the LLM service module is mocked so any accidental use would
// register a call. It must never be touched on the CompetitiveLandscape path.
const executeSpy = vi.fn();
vi.mock('../../src/services/llm.js', () => ({
  getLlmService: () => ({ execute: executeSpy, strategizeJson: executeSpy, executePolicyJson: executeSpy }),
}));

function serp(
  keyword: string,
  items: Array<{ rank: number; url: string }>,
  observedAt = '2024-01-01T00:00:00.000Z',
): OrganicSerpResult {
  return {
    keyword,
    locationName: 'United States',
    languageName: 'English',
    device: 'desktop',
    observedAt,
    serpFeatures: [],
    items: items.map((item) => ({
      rankAbsolute: item.rank,
      rankGroup: item.rank,
      url: item.url,
      domain: new URL(item.url).hostname.replace('www.', ''),
      title: '',
      snippet: '',
    })),
  };
}

class FakePort implements DataForSeoOrganicPort {
  public calls = 0;
  constructor(private readonly map: Record<string, OrganicSerpResult>) {}
  async getOrganicSerp(params: { keyword: string }): Promise<OrganicSerpResult> {
    this.calls += 1;
    return this.map[params.keyword] ?? serp(params.keyword, []);
  }
}

const baseRequest: CompetitiveLandscapeRequest = {
  client_id: 'client-1',
  build_id: 'build-1',
  market: { niche: 'roofing', country: 'United States', language: 'English', device: 'desktop' },
  seed_queries: [
    { query: 'metal roofing', intent: 'commercial', weight: 2 },
    { query: 'roof repair', intent: 'transactional' },
  ],
  desired_donor_count: 3,
};

function fixtureMap(): Record<string, OrganicSerpResult> {
  return {
    'metal roofing': serp('metal roofing', [
      { rank: 1, url: 'https://www.alpha-roofing.com/metal' },
      { rank: 2, url: 'https://beta-roofs.com/' },
      { rank: 3, url: 'https://www.facebook.com/someroofer' },
    ]),
    'roof repair': serp('roof repair', [
      { rank: 1, url: 'https://alpha-roofing.com/repair' }, // same domain as www.alpha-roofing.com
      { rank: 2, url: 'https://yelp.com/biz/roofers' },
      { rank: 4, url: 'https://gamma-roofing.com/repair' },
    ]),
  };
}

describe('CompetitiveLandscape — deterministic ranking truth', () => {
  it('produces the same semantic digest for the same SERP fixture (determinism)', async () => {
    const a = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    const b = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    expect(a.integrity.payload_digest).toBe(b.integrity.payload_digest);
    expect(a.artifact_id).toBe(b.artifact_id);
    expect(() => assertIntelligenceArtifactIntegrity(a)).not.toThrow();
  });

  it('invokes ZERO LLM operations', async () => {
    await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('records organic-only observations with exact ranking URL, canonical domain, and query id', async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    const obs = artifact.payload.observations;
    // Every observation is dataforseo-sourced with an organic rank >= 1.
    for (const o of obs) {
      expect(o.source).toBe('dataforseo');
      expect(o.rank).toBeGreaterThanOrEqual(1);
      expect(o.observed_at).toBe('2024-01-01T00:00:00.000Z');
    }
    // Exact observed URL preserved separately from the canonical domain.
    const alpha = obs.find((o) => o.url === 'https://www.alpha-roofing.com/metal');
    expect(alpha).toBeDefined();
    expect(alpha!.domain).toBe('alpha-roofing.com');
  });

  it('normalizes www/protocol/path variants to one canonical domain (dedupe)', async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    const alpha = artifact.payload.domains.find((d) => d.domain === 'alpha-roofing.com');
    expect(alpha).toBeDefined();
    // Two observations (www.alpha-roofing.com/metal + alpha-roofing.com/repair) fold together.
    expect(alpha!.observation_ids).toHaveLength(2);
    expect(alpha!.qualifying_query_ids.sort()).toEqual(['q1', 'q2']);
  });

  it('computes visibility as Σ weight × 1/log2(rank+1), deterministically', async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    const alpha = artifact.payload.domains.find((d) => d.domain === 'alpha-roofing.com')!;
    // q1 weight 2 @ rank1: 2 * 1/log2(2) = 2 ; q2 weight 1 @ rank1: 1 * 1/log2(2) = 1
    const expected = Math.round((2 * (1 / Math.log2(2)) + 1 * (1 / Math.log2(2))) * 1e6) / 1e6;
    expect(alpha.aggregate_visibility).toBe(expected);
  });

  it('excludes social/directory domains and operator exclusions, each WITH a reason, never silently', async () => {
    const artifact = await createCompetitiveLandscape(
      { ...baseRequest, operator_exclusions: ['gamma-roofing.com'] },
      { dataForSeo: new FakePort(fixtureMap()) },
    );
    const byDomain = Object.fromEntries(artifact.payload.exclusions.map((e) => [e.domain, e.reason]));
    expect(byDomain['facebook.com']).toBe('social');
    expect(byDomain['yelp.com']).toBe('directory');
    expect(byDomain['gamma-roofing.com']).toBe('operator_exclusion');
    const donorDomains = artifact.payload.selected_donors.map((d) => d.domain);
    expect(donorDomains).not.toContain('facebook.com');
    expect(donorDomains).not.toContain('yelp.com');
    expect(donorDomains).not.toContain('gamma-roofing.com');
    expect(donorDomains).toContain('alpha-roofing.com');
  });

  it('guarantees every selected donor resolves to at least one real observation', async () => {
    const artifact = await createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort(fixtureMap()) });
    const observationIds = new Set(artifact.payload.observations.map((o) => o.observation_id));
    for (const donor of artifact.payload.selected_donors) {
      expect(donor.observation_ids.length).toBeGreaterThanOrEqual(1);
      for (const id of donor.observation_ids) expect(observationIds.has(id)).toBe(true);
    }
  });

  it('returns a partial cohort with evidence_complete=false when donors are insufficient', async () => {
    const artifact = await createCompetitiveLandscape(
      { ...baseRequest, desired_donor_count: 10 },
      { dataForSeo: new FakePort(fixtureMap()) },
    );
    expect(artifact.payload.selected_donors.length).toBeLessThan(10);
    expect(artifact.payload.evidence_complete).toBe(false);
  });

  it('fails closed (COMPETITIVE_EVIDENCE_INCOMPLETE) when there is no evidence at all', async () => {
    await expect(
      createCompetitiveLandscape(baseRequest, { dataForSeo: new FakePort({}) }),
    ).rejects.toBeInstanceOf(CompetitiveEvidenceIncompleteError);
  });

  it('does not manufacture donors to hit the requested count', async () => {
    const artifact = await createCompetitiveLandscape(
      { ...baseRequest, desired_donor_count: 50 },
      { dataForSeo: new FakePort(fixtureMap()) },
    );
    // Only real, non-excluded domains appear; count never padded up to 50.
    const donorDomains = artifact.payload.selected_donors.map((d) => d.domain);
    expect(new Set(donorDomains).size).toBe(donorDomains.length);
    expect(donorDomains.length).toBeLessThanOrEqual(3);
  });
});
