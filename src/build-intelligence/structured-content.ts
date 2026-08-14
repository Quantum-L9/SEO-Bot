/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 4 — StructuredContentPackage (final prose, SEO-Bot owned)
 *
 * Lineage is checked FIRST (`assertIntelligenceArtifactIntegrity`) so an invalid
 * PageContentContract is rejected BEFORE any LLM spend. Prose is generated PER
 * ROUTE (one owner, not one enormous whole-site prompt): each route call sees
 * only its own contract route + allowed facts — never raw competitor pages or
 * Website-Bot implementation details.
 *
 * Generation → validation (Phase 5) → ONE bounded repair scoped to the failing
 * route(s) + their failed requirements → terminal typed failure. Passing routes
 * are never regenerated. The package seals only when every route passes.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  assertIntelligenceArtifactIntegrity,
  refForArtifact,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
  type PageContentContractArtifact,
  type PageContentContractRoute,
  type SEOContentBlueprintArtifact,
  type SEOContentBlueprintRoute,
  type StructuredContentPackageArtifact,
  type StructuredContentPackageV1,
  type StructuredContentRoute,
} from '@quantum-l9/bot-interop';
import { createModuleLogger } from '../core/logger.js';
import { getLlmService, type LlmService } from '../services/llm.js';
import { PRODUCER } from './producer.js';
import { structuredContentRouteSchema } from './schema-guards.js';
import { validateRoute, type RouteValidationVerdict } from './content-validator.js';

const logger = createModuleLogger('build-intelligence:structured-content');

export interface StructuredContentRequest {
  client_id: string;
  build_id: string;
  page_content_contract: PageContentContractArtifact;
  /** Optional blueprint for search-intent cross-checks during validation. */
  seo_content_blueprint?: SEOContentBlueprintArtifact;
}

/** Thrown when a route still fails its requirements after the one bounded repair. */
export class ContentRequirementUnsatisfiedError extends Error {
  readonly code = 'CONTENT_REQUIREMENT_UNSATISFIED';
  constructor(message: string, readonly failedRequirements: string[]) {
    super(message);
    this.name = 'ContentRequirementUnsatisfiedError';
  }
}

export async function createStructuredContentPackage(
  request: StructuredContentRequest,
  deps: { llm?: LlmService } = {},
): Promise<StructuredContentPackageArtifact> {
  // ── Lineage first: reject a tampered/invalid contract BEFORE any LLM spend ────
  assertIntelligenceArtifactIntegrity(request.page_content_contract);

  const llm = deps.llm ?? getLlmService();
  const contract = request.page_content_contract.payload;
  const blueprintRoutes = new Map<string, SEOContentBlueprintRoute>(
    (request.seo_content_blueprint?.payload.routes ?? []).map((route) => [route.route_id, route]),
  );

  const routes: StructuredContentRoute[] = [];
  const verdicts: RouteValidationVerdict[] = [];

  for (const contractRoute of contract.routes) {
    const blueprintRoute = blueprintRoutes.get(contractRoute.route_id);

    // 1. Generate prose for this route only.
    let generated = await generateRoute(llm, request, contractRoute);

    // 2. Validate (deterministic then semantic).
    let verdict = await validateRoute(generated, contractRoute, {
      clientId: request.client_id,
      buildId: request.build_id,
      blueprintRoute,
      llm,
    });

    // 3. ONE bounded repair, scoped to this route + its failed requirements.
    if (!routePassed(verdict)) {
      logger.warn(
        { routeId: contractRoute.route_id, failed: verdict.failed_requirements, unsupported: verdict.unsupported_claims },
        'Route failed validation; running one bounded repair',
      );
      generated = await generateRoute(llm, request, contractRoute, {
        failed_requirements: verdict.failed_requirements,
        unsupported_claims: verdict.unsupported_claims,
      });
      verdict = await validateRoute(generated, contractRoute, {
        clientId: request.client_id,
        buildId: request.build_id,
        blueprintRoute,
        llm,
      });

      // 4. Second failure is terminal.
      if (!routePassed(verdict)) {
        throw new ContentRequirementUnsatisfiedError(
          `Route "${contractRoute.route_id}" still fails validation after one bounded repair`,
          verdict.failed_requirements,
        );
      }
    }

    routes.push(generated);
    verdicts.push(verdict);
  }

  const validation: StructuredContentPackageV1['validation'] = {
    seo_blueprint_passed: verdicts.every((verdict) => verdict.seo_blueprint_passed),
    contract_passed: verdicts.every((verdict) => verdict.contract_passed),
    unsupported_claims: dedupe(verdicts.flatMap((verdict) => verdict.unsupported_claims)),
    failed_requirements: dedupe(verdicts.flatMap((verdict) => verdict.failed_requirements)),
  };

  const payload: StructuredContentPackageV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.structuredContentPackage,
    page_content_contract_ref: refForArtifact(request.page_content_contract),
    routes,
    validation,
  };

  const artifact = sealIntelligenceArtifact({
    artifact_type: 'structured_content_package',
    client_id: request.client_id,
    build_id: request.build_id,
    producer: PRODUCER,
    input_refs: [refForArtifact(request.page_content_contract)],
    payload,
  });

  logger.info(
    {
      clientId: request.client_id,
      buildId: request.build_id,
      routes: routes.length,
      pageContentContractRef: payload.page_content_contract_ref.artifact_id,
      artifactId: artifact.artifact_id,
    },
    'StructuredContentPackage sealed',
  );

  return artifact;
}

/**
 * Generate a single route's final content from ONLY its contract route. An
 * optional `repair` payload appends the specific failures to fix — scoping the
 * repair to this route without regenerating anything that already passed.
 */
async function generateRoute(
  llm: LlmService,
  request: StructuredContentRequest,
  contractRoute: PageContentContractRoute,
  repair?: { failed_requirements: string[]; unsupported_claims: string[] },
): Promise<StructuredContentRoute> {
  const systemPrompt =
    'You are the sole owner of final website prose for one route. Write ONLY from ' +
    'the supplied contract and allowed facts. Never invent facts or claims; every ' +
    'claim must be backed by an allowed fact. Respect forbidden claims. Cover the ' +
    'required topics/entities, answer the required questions, and satisfy the proof ' +
    'requirements. Produce a metadata title and description that satisfy their ' +
    'requirements. Produce exactly one section object per contract section_id (same ' +
    'ids), plus faqs, internal links (including every required internal-link target), ' +
    'and schema_content_inputs. Respond with ONLY a single JSON object for this ' +
    'route — no markdown fences, no commentary.';

  const repairBlock = repair
    ? {
        repair_instructions: {
          note: 'Your previous output failed validation. Fix ONLY the items below; keep everything else compliant.',
          failed_requirements: repair.failed_requirements,
          remove_or_support_unsupported_claims: repair.unsupported_claims,
        },
      }
    : {};

  const userPrompt = JSON.stringify({
    contract_route: contractRoute,
    required_internal_link_targets: contractRoute.internal_link_requirements.map((link) => link.target_route_id),
    required_section_ids: contractRoute.sections.map((section) => section.section_id),
    ...repairBlock,
  }, null, 2);

  return llm.executePolicyJson('STRUCTURED_CONTENT_GENERATION', {
    clientId: request.client_id,
    module: 'build-intelligence',
    purpose: `structured-content:${contractRoute.route_id}`,
    systemPrompt,
    userPrompt,
    validate: (value) => reconcileStructuredRoute(value, contractRoute),
  });
}

/**
 * Validate model output and re-assert route/section identity from the contract
 * (identity is an input, not the model's to change). Sections are returned in
 * contract order; an unexpected or missing section_id throws (→ bounded repair).
 */
function reconcileStructuredRoute(
  value: unknown,
  contractRoute: PageContentContractRoute,
): StructuredContentRoute {
  const parsed = structuredContentRouteSchema.parse(value);

  const contractSectionIds = contractRoute.sections.map((section) => section.section_id);
  const contractSet = new Set(contractSectionIds);
  const producedById = new Map(parsed.sections.map((section) => [section.section_id, section]));

  const unexpected = parsed.sections.map((section) => section.section_id).filter((id) => !contractSet.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected section_id(s) not in contract: ${unexpected.join(', ')}`);
  }
  const sections = contractSectionIds.map((id) => {
    const section = producedById.get(id);
    if (!section) throw new Error(`Missing required section_id: ${id}`);
    return section;
  });

  return { ...parsed, route_id: contractRoute.route_id, path: contractRoute.path, sections };
}

function routePassed(verdict: RouteValidationVerdict): boolean {
  return (
    verdict.contract_passed &&
    verdict.seo_blueprint_passed &&
    verdict.failed_requirements.length === 0 &&
    verdict.unsupported_claims.length === 0
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}
