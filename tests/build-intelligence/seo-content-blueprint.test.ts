/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, it, expect, vi } from 'vitest';
import {
  sealIntelligenceArtifact,
  refForArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
  assertIntelligenceArtifactIntegrity,
  type CompetitiveLandscapeArtifact,
  type CompetitiveLandscapeV1,
  type SEOContentBlueprintRoute,
} from '@quantum-l9/bot-interop';
import {
  createSEOContentBlueprint,
  type PageContentPort,
} from '../../src/build-intelligence/seo-content-blueprint.js';
import type { LlmService } from '../../src/services/llm.js';

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeLandscape(): CompetitiveLandscapeArtifact {
  const payload: CompetitiveLandscapeV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape,
    market: { niche: 'roofing', country: 'United States', language: 'English', device: 'desktop' },
    query_portfolio: [{ query_id: 'q1', query: 'metal roofing', intent: 'commercial', weight: 1 }],
    observations: [{
      observation_id: 'q1-r1', query_id: 'q1', rank: 1,
      url: 'https://alpha-roofing.com/metal', domain: 'alpha-roofing.com',
      observed_at: '2024-01-01T00:00:00.000Z', source: 'dataforseo',
    }],
    domains: [{ domain: 'alpha-roofing.com', aggregate_visibility: 1, qualifying_query_ids: ['q1'], observation_ids: ['q1-r1'] }],
    selected_donors: [{ domain: 'alpha-roofing.com', aggregate_visibility: 1, observation_ids: ['q1-r1'] }],
    exclusions: [],
    evidence_complete: true,
  };
  return sealIntelligenceArtifact({
    artifact_type: 'competitive_landscape', client_id: 'client-1', build_id: 'build-1',
    producer: { repo: 'SEO-Bot', version: '2.1.0' }, payload,
  });
}

function blueprintRoute(routeId: string, path: string): SEOContentBlueprintRoute {
  return {
    route_id: routeId, path,
    search_intent: { primary: 'hire a metal roofer', secondary: [], journey_stage: 'commercial' },
    targets: { primary_query: 'metal roofing', supporting_queries: [], topics: ['durability'], entities: ['metal roof'] },
    requirements: [{
      requirement_id: 'r1', target_slots: ['primary_offer'], placement: 'FIRST_MATCH',
      required_topics: ['durability'], required_entities: ['metal roof'], questions: ['how long does it last?'],
      proof_needed: ['warranty'], required: true,
    }],
    competitive_gaps: [{ gap_id: 'g1', description: 'no pricing', donor_domains: ['alpha-roofing.com'], opportunity: 'add pricing' }],
    internal_links: [], aeo_geo: { answer_targets: [], schema_requirements: [] },
    metadata: { title_requirements: ['include city'], description_requirements: ['<160 chars'] },
    forbidden_claims: [], acceptance_tests: ['mentions warranty'],
  };
}

const requestedRoutes = [{ route_id: 'home', path: '/', purpose: 'primary landing' }];

function fakeLlm(modelRoutes: SEOContentBlueprintRoute[]): { llm: LlmService; calls: { strategize: number } } {
  const calls = { strategize: 0 };
  const llm = {
    strategizeJson: async (args: { validate: (v: unknown) => unknown }) => {
      calls.strategize += 1;
      return args.validate({ routes: modelRoutes });
    },
  } as unknown as LlmService;
  return { llm, calls };
}

const fakePages: PageContentPort = {
  async getPageContent() {
    return { wordCount: 800, headings: 6, images: 3, internalLinks: 10, externalLinks: 2 };
  },
};

describe('SEOContentBlueprint — strategic reasoning, exact lineage', () => {
  it('references the EXACT CompetitiveLandscape artifact', async () => {
    const landscape = makeLandscape();
    const { llm } = fakeLlm([blueprintRoute('home', '/')]);
    const artifact = await createSEOContentBlueprint(
      { client_id: 'client-1', build_id: 'build-1', competitive_landscape: landscape, routes: requestedRoutes, business_facts: [] },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.payload.competitive_landscape_ref).toEqual(refForArtifact(landscape));
    expect(artifact.input_refs).toEqual([refForArtifact(landscape)]);
    expect(() => assertIntelligenceArtifactIntegrity(artifact)).not.toThrow();
  });

  it('uses the strategic-reasoning path (strategizeJson), not extraction', async () => {
    const { llm, calls } = fakeLlm([blueprintRoute('home', '/')]);
    await createSEOContentBlueprint(
      { client_id: 'client-1', build_id: 'build-1', competitive_landscape: makeLandscape(), routes: requestedRoutes, business_facts: [] },
      { llm, dataForSeo: fakePages },
    );
    expect(calls.strategize).toBe(1);
  });

  it('seals the shared SEOContentBlueprint schema with exactly the requested routes', async () => {
    const { llm } = fakeLlm([blueprintRoute('home', '/')]);
    const artifact = await createSEOContentBlueprint(
      { client_id: 'client-1', build_id: 'build-1', competitive_landscape: makeLandscape(), routes: requestedRoutes, business_facts: [] },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.payload.schema).toBe(WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint);
    expect(artifact.payload.routes.map((r) => r.route_id)).toEqual(['home']);
  });

  it('re-asserts route identity from the request (model cannot invent routes/paths)', async () => {
    // Model returns a route with a tampered path + an extra unexpected route.
    const tampered = blueprintRoute('home', '/WRONG');
    const extra = blueprintRoute('ghost', '/ghost');
    const { llm } = fakeLlm([tampered, extra]);
    await expect(
      createSEOContentBlueprint(
        { client_id: 'client-1', build_id: 'build-1', competitive_landscape: makeLandscape(), routes: requestedRoutes, business_facts: [] },
        { llm, dataForSeo: fakePages },
      ),
    ).rejects.toThrow(/Unexpected route_id/);
  });

  it('carries only the CompetitiveLandscape as an input ref (no WebsiteBuildBlueprint dependency)', async () => {
    const { llm } = fakeLlm([blueprintRoute('home', '/')]);
    const artifact = await createSEOContentBlueprint(
      { client_id: 'client-1', build_id: 'build-1', competitive_landscape: makeLandscape(), routes: requestedRoutes, business_facts: [] },
      { llm, dataForSeo: fakePages },
    );
    expect(artifact.input_refs).toHaveLength(1);
    expect(artifact.input_refs[0]!.artifact_type).toBe('competitive_landscape');
  });

  it('prompts with the nested route_shape the schema enforces (regression: flat journey_stage contract made every live call fail schema validation)', async () => {
    let capturedUserPrompt: string | null = null;
    const llm = {
      strategizeJson: async (args: { systemPrompt: string; userPrompt: string; validate: (v: unknown) => unknown }) => {
        capturedUserPrompt = args.userPrompt;
        return args.validate({ routes: [blueprintRoute('home', '/')] });
      },
    } as unknown as LlmService;
    await createSEOContentBlueprint(
      { client_id: 'client-1', build_id: 'build-1', competitive_landscape: makeLandscape(), routes: requestedRoutes, business_facts: [] },
      { llm, dataForSeo: fakePages },
    );
    const contract = JSON.parse(capturedUserPrompt!).output_contract;
    expect(contract.route_shape.search_intent.journey_stage).toContain('informational');
    expect(contract.route_shape.targets.primary_query).toBeTruthy();
    expect(contract.journey_stage).toBeUndefined();
  });
});
