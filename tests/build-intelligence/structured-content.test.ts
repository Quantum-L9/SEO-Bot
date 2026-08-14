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
  type ArtifactRef,
  type PageContentContractArtifact,
  type PageContentContractV1,
  type StructuredContentRoute,
} from '@quantum-l9/bot-interop';
import {
  createStructuredContentPackage,
  ContentRequirementUnsatisfiedError,
} from '../../src/build-intelligence/structured-content.js';
import type { LlmService } from '../../src/services/llm.js';
import type { ContentValidationVerdict } from '../../src/build-intelligence/schema-guards.js';

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const dummyRef: ArtifactRef = { artifact_type: 'website_build_blueprint', artifact_id: 'x', payload_digest: 'y' };

function makeContract(): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: 'website-content-contract-compiler', version: '1.0.0', warnings: [] },
    inputs: { website_build_blueprint: dummyRef, seo_content_blueprint: { ...dummyRef, artifact_type: 'seo_content_blueprint' }, business_facts_digest: 'abc' },
    routes: [{
      route_id: 'home', path: '/', purpose: 'primary landing',
      search_context: { primary_intent: 'hire', secondary_intents: [], primary_query: 'metal roofing', supporting_queries: [], topics: ['durability'], entities: ['metal roof'] },
      metadata_requirements: { title: ['include city'], description: ['<160 chars'] },
      business_facts: [],
      sections: [{
        section_id: 'hero', component_class: 'hero', objective: 'convey primary offer',
        slots: ['primary_offer'],
        content_requirements: { requirement_ids: ['r1'], topics: ['durability'], entities: ['metal roof'], questions: ['how long?'] },
        allowed_fact_ids: [], proof_requirements: ['warranty'], acceptance_tests: ['mentions warranty'],
      }],
      internal_link_requirements: [],
      forbidden_claims: ['lifetime free'],
      acceptance_tests: ['metadata present'],
    }],
  };
  return sealIntelligenceArtifact({
    artifact_type: 'page_content_contract', client_id: 'client-1', build_id: 'build-1',
    producer: { repo: 'Website-Bot', version: '1.0.0' }, payload,
  });
}

function genRoute(): StructuredContentRoute {
  return {
    route_id: 'home', path: '/',
    metadata: { title: 'Metal Roofing in Austin', description: 'Durable metal roofs backed by warranty.' },
    sections: [{ section_id: 'hero', heading: 'Metal Roofing', blocks: [{ kind: 'paragraph', text: 'Durable metal roofing backed by a warranty.' }] }],
    faqs: [], internal_links: [], schema_content_inputs: {},
  };
}

const pass: ContentValidationVerdict = { seo_blueprint_passed: true, contract_passed: true, unsupported_claims: [], failed_requirements: [] };
const fail: ContentValidationVerdict = { seo_blueprint_passed: false, contract_passed: false, unsupported_claims: ['unbacked pricing claim'], failed_requirements: ['home: unsupported claim'] };

function fakeLlm(verdicts: ContentValidationVerdict[]): { llm: LlmService; counts: { gen: number; val: number } } {
  const counts = { gen: 0, val: 0 };
  const llm = {
    async executePolicyJson(operation: string, args: { validate: (v: unknown) => unknown }) {
      if (operation === 'STRUCTURED_CONTENT_GENERATION') { counts.gen += 1; return args.validate(genRoute()); }
      if (operation === 'CONTENT_VALIDATION') { const v = verdicts[Math.min(counts.val, verdicts.length - 1)]; counts.val += 1; return args.validate(v); }
      throw new Error(`unexpected op ${operation}`);
    },
  } as unknown as LlmService;
  return { llm, counts };
}

describe('StructuredContentPackage — lineage, identity, bounded repair', () => {
  it('rejects a tampered PageContentContract BEFORE any LLM spend', async () => {
    const contract = makeContract();
    // Tamper the sealed payload so its digest no longer matches integrity.
    (contract.payload.routes[0] as { path: string }).path = '/tampered';
    const { llm, counts } = fakeLlm([pass]);
    await expect(
      createStructuredContentPackage({ client_id: 'client-1', build_id: 'build-1', page_content_contract: contract }, { llm }),
    ).rejects.toThrow(/INTEL_ARTIFACT_HASH_MISMATCH/);
    expect(counts.gen).toBe(0);
    expect(counts.val).toBe(0);
  });

  it('preserves route IDs and section IDs from the contract exactly', async () => {
    const { llm } = fakeLlm([pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: 'client-1', build_id: 'build-1', page_content_contract: makeContract() }, { llm },
    );
    expect(pkg.payload.routes.map((r) => r.route_id)).toEqual(['home']);
    expect(pkg.payload.routes[0]!.sections.map((s) => s.section_id)).toEqual(['hero']);
  });

  it('references the EXACT PageContentContract artifact', async () => {
    const contract = makeContract();
    const { llm } = fakeLlm([pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: 'client-1', build_id: 'build-1', page_content_contract: contract }, { llm },
    );
    expect(pkg.payload.page_content_contract_ref).toEqual(refForArtifact(contract));
    expect(pkg.input_refs).toEqual([refForArtifact(contract)]);
  });

  it('fires exactly ONE bounded repair when a route first fails, then seals on success', async () => {
    const { llm, counts } = fakeLlm([fail, pass]);
    const pkg = await createStructuredContentPackage(
      { client_id: 'client-1', build_id: 'build-1', page_content_contract: makeContract() }, { llm },
    );
    expect(counts.gen).toBe(2); // initial + one repair
    expect(counts.val).toBe(2); // validate after each generation
    expect(pkg.payload.validation.contract_passed).toBe(true);
    expect(pkg.payload.validation.unsupported_claims).toEqual([]);
  });

  it('is terminal (CONTENT_REQUIREMENT_UNSATISFIED) when the route still fails after repair', async () => {
    const { llm, counts } = fakeLlm([fail, fail]);
    await expect(
      createStructuredContentPackage({ client_id: 'client-1', build_id: 'build-1', page_content_contract: makeContract() }, { llm }),
    ).rejects.toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect(counts.gen).toBe(2); // no unbounded retry beyond the single repair
  });
});
