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
  type PageContentContractArtifact,
  type PageContentContractRoute,
  refForArtifact,
  type SEOContentBlueprintArtifact,
  type SEOContentBlueprintRoute,
  type StructuredContentPackageArtifact,
  type StructuredContentPackageV1,
  type StructuredContentRoute,
  sameArtifactRef,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { getLlmService, type LlmCallCounter, type LlmService } from "../services/llm.js";
import { type RouteValidationVerdict, validateRoute } from "./content-validator.js";
import { PRODUCER } from "./producer.js";
import {
  type SchemaFailure,
  schemaFailureDetails,
  STRUCTURED_CONTENT_OUTPUT_CONTRACT,
  structuredContentRouteSchema,
} from "./schema-guards.js";

const logger = createModuleLogger("build-intelligence:structured-content");

export interface StructuredContentRequest {
  client_id: string;
  build_id: string;
  page_content_contract: PageContentContractArtifact;
  /** Optional blueprint for search-intent cross-checks during validation. */
  seo_content_blueprint?: SEOContentBlueprintArtifact;
}

/** Thrown when a route still fails its requirements after the one bounded repair. */
export class ContentRequirementUnsatisfiedError extends Error {
  readonly code = "CONTENT_REQUIREMENT_UNSATISFIED";
  constructor(
    message: string,
    readonly failedRequirements: string[],
    readonly unsupportedClaims: string[] = [],
  ) {
    super(message);
    this.name = "ContentRequirementUnsatisfiedError";
  }
}

/** The supplied PageContentContract is not a usable generation authority. */
export class PageContentContractInvalidError extends Error {
  readonly code = "PAGE_CONTENT_CONTRACT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PageContentContractInvalidError";
  }
}

/** The sealed package's route set does not exactly match the contract's. */
export class StructuredContentRouteMismatchError extends Error {
  readonly code = "STRUCTURED_CONTENT_ROUTE_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "StructuredContentRouteMismatchError";
  }
}

/** The sealed package does not reference the exact contract it was built from. */
export class ArtifactLineageMismatchError extends Error {
  readonly code = "ARTIFACT_LINEAGE_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "ArtifactLineageMismatchError";
  }
}

/**
 * Measured evidence about the run, for the integrity receipt. Every counter is
 * COUNTED from actual LLM calls, never inferred — a sealed package always has a
 * clean validation block, so the block itself cannot tell you whether a repair
 * happened or how many calls it took. `repair_attempts` is bounded by
 * construction: at most `route_count` and at most one per route.
 */
export interface StructuredContentEvidence {
  route_count: number;
  generation_llm_calls: number;
  semantic_validation_llm_calls: number;
  repair_attempts: number;
  schema_failure_count: number;
  repaired_route_ids: string[];
}

export interface StructuredContentResult {
  artifact: StructuredContentPackageArtifact;
  evidence: StructuredContentEvidence;
}

/**
 * Produce the sealed package. Use `createStructuredContentPackageWithEvidence`
 * when the caller also needs measured run evidence (the seam proof does).
 */
export async function createStructuredContentPackage(
  request: StructuredContentRequest,
  deps: { llm?: LlmService } = {},
): Promise<StructuredContentPackageArtifact> {
  return (await createStructuredContentPackageWithEvidence(request, deps)).artifact;
}

export async function createStructuredContentPackageWithEvidence(
  request: StructuredContentRequest,
  deps: { llm?: LlmService } = {},
): Promise<StructuredContentResult> {
  // ── Lineage first: reject a tampered/invalid/foreign contract BEFORE any
  //    LLM spend. Integrity, identity, and structure are all checked here.
  assertContractUsable(request);

  const llm = deps.llm ?? getLlmService();
  const contract = request.page_content_contract.payload;
  const blueprintRoutes = new Map<string, SEOContentBlueprintRoute>(
    (request.seo_content_blueprint?.payload.routes ?? []).map((route) => [route.route_id, route]),
  );

  // Actual-call counters shared across the whole run. Generation uses
  // `schemaRepairAttempts: 0` so each generateRoute() is exactly one LLM call;
  // the semantic-validation path counts through a wrapper that injects its own
  // counter into content-validator's executePolicyJson call.
  const generationCalls: LlmCallCounter = { value: 0 };
  const semanticValidationCalls: LlmCallCounter = { value: 0 };
  const validationLlm = countingValidationLlm(llm, semanticValidationCalls);

  const routes: StructuredContentRoute[] = [];
  const verdicts: RouteValidationVerdict[] = [];
  const repairedRouteIds: string[] = [];
  let schemaFailureCount = 0;

  for (const contractRoute of contract.routes) {
    const blueprintRoute = blueprintRoutes.get(contractRoute.route_id);

    // 1. Generate prose for this route only — ONE actual call (no internal
    //    repair: the orchestrator owns the one total repair for the route).
    let schemaFailures: SchemaFailure[] = [];
    let generated: StructuredContentRoute | null = null;
    try {
      generated = await generateRoute(llm, request, contractRoute, undefined, generationCalls);
    } catch (error) {
      schemaFailures = schemaFailureDetails(error);
      schemaFailureCount += 1;
      logger.warn(
        { routeId: contractRoute.route_id, failures: schemaFailures },
        "Route generation failed JSON/schema validation; deferring to the one route repair",
      );
    }

    // 2. Validate (deterministic then semantic). A route that never parsed
    //    cannot be validated — its repair below is fed the schema failures.
    let verdict: RouteValidationVerdict;
    if (generated === null) {
      verdict = {
        route_id: contractRoute.route_id,
        contract_passed: false,
        seo_blueprint_passed: false,
        unsupported_claims: [],
        failed_requirements: [],
      };
    } else {
      verdict = await validateRoute(generated, contractRoute, {
        clientId: request.client_id,
        buildId: request.build_id,
        blueprintRoute,
        llm: validationLlm,
      });
    }

    // 3. ONE bounded repair covers a schema failure OR a semantic failure —
    //    never both, so a route consumes at most two generation calls. The
    //    repair prompt carries the exact failure evidence and the output
    //    contract again.
    if (generated === null || !routePassed(verdict)) {
      repairedRouteIds.push(contractRoute.route_id);
      logger.warn(
        {
          routeId: contractRoute.route_id,
          schemaFailures,
          failed: verdict.failed_requirements,
          unsupported: verdict.unsupported_claims,
        },
        "Route failed validation; running its one bounded repair",
      );
      let repaired: StructuredContentRoute;
      try {
        repaired = await generateRoute(
          llm,
          request,
          contractRoute,
          {
            schema_failures: schemaFailures,
            failed_requirements: verdict.failed_requirements,
            unsupported_claims: verdict.unsupported_claims,
          },
          generationCalls,
        );
      } catch (error) {
        schemaFailureCount += 1;
        const repairFailures = schemaFailureDetails(error);
        throw new ContentRequirementUnsatisfiedError(
          `Route "${contractRoute.route_id}" repair produced invalid content: ` +
            repairFailures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
          verdict.failed_requirements,
          verdict.unsupported_claims,
        );
      }
      generated = repaired;
      verdict = await validateRoute(repaired, contractRoute, {
        clientId: request.client_id,
        buildId: request.build_id,
        blueprintRoute,
        llm: validationLlm,
      });

      // 4. Second failure is terminal. There is no second repair.
      if (!routePassed(verdict)) {
        throw new ContentRequirementUnsatisfiedError(
          `Route "${contractRoute.route_id}" still fails validation after one bounded repair`,
          verdict.failed_requirements,
          verdict.unsupported_claims,
        );
      }
    }

    routes.push(generated);
    verdicts.push(verdict);
  }

  const validation: StructuredContentPackageV1["validation"] = {
    seo_blueprint_passed: verdicts.every((verdict) => verdict.seo_blueprint_passed),
    contract_passed: verdicts.every((verdict) => verdict.contract_passed),
    unsupported_claims: dedupe(verdicts.flatMap((verdict) => verdict.unsupported_claims)),
    failed_requirements: dedupe(verdicts.flatMap((verdict) => verdict.failed_requirements)),
  };

  const contractRef = refForArtifact(request.page_content_contract);
  const payload: StructuredContentPackageV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.structuredContentPackage,
    page_content_contract_ref: contractRef,
    routes,
    validation,
  };

  assertPackageLineage(payload, contract.routes, contractRef);

  const artifact = sealIntelligenceArtifact({
    artifact_type: "structured_content_package",
    client_id: request.client_id,
    build_id: request.build_id,
    producer: PRODUCER,
    input_refs: [contractRef],
    payload,
  });

  logger.info(
    {
      clientId: request.client_id,
      buildId: request.build_id,
      routes: routes.length,
      pageContentContractRef: payload.page_content_contract_ref.artifact_id,
      artifactId: artifact.artifact_id,
      repairedRoutes: repairedRouteIds.length,
    },
    "StructuredContentPackage sealed",
  );

  return {
    artifact,
    evidence: {
      route_count: routes.length,
      generation_llm_calls: generationCalls.value,
      semantic_validation_llm_calls: semanticValidationCalls.value,
      // Bounded at one per route by construction; a second failure is terminal.
      repair_attempts: repairedRouteIds.length,
      schema_failure_count: schemaFailureCount,
      repaired_route_ids: repairedRouteIds,
    },
  };
}

/**
 * The exact supplied PageContentContract is the ONLY generation authority.
 * Everything that could make it the wrong authority is rejected here, before a
 * single token is spent: tampered integrity, wrong artifact type, wrong schema,
 * a different client, a different build, or an unusable route structure.
 */
function assertContractUsable(request: StructuredContentRequest): void {
  const artifact = request.page_content_contract;
  // Throws INTEL_ARTIFACT_HASH_MISMATCH / INTEL_ARTIFACT_SCHEMA_MISMATCH.
  assertIntelligenceArtifactIntegrity(artifact);

  if (artifact.artifact_type !== "page_content_contract") {
    throw new PageContentContractInvalidError(
      `expected a page_content_contract artifact, received ${artifact.artifact_type}`,
    );
  }
  if (artifact.payload?.schema !== WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract) {
    throw new PageContentContractInvalidError(
      `unexpected PageContentContract payload schema: ${String(artifact.payload?.schema)}`,
    );
  }
  if (artifact.client_id !== request.client_id) {
    throw new PageContentContractInvalidError(
      `contract client_id "${artifact.client_id}" does not match request client_id "${request.client_id}"`,
    );
  }
  if (artifact.build_id !== request.build_id) {
    throw new PageContentContractInvalidError(
      `contract build_id "${artifact.build_id}" does not match request build_id "${request.build_id}"`,
    );
  }

  const routes = artifact.payload.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new PageContentContractInvalidError("contract declares no routes");
  }
  const seenRouteIds = new Set<string>();
  for (const route of routes) {
    if (seenRouteIds.has(route.route_id)) {
      throw new PageContentContractInvalidError(
        `duplicate route_id in contract: ${route.route_id}`,
      );
    }
    seenRouteIds.add(route.route_id);
    if (!Array.isArray(route.sections) || route.sections.length === 0) {
      throw new PageContentContractInvalidError(
        `contract route "${route.route_id}" declares no sections`,
      );
    }
    const seenSectionIds = new Set<string>();
    for (const section of route.sections) {
      if (seenSectionIds.has(section.section_id)) {
        throw new PageContentContractInvalidError(
          `duplicate section_id "${section.section_id}" in contract route "${route.route_id}"`,
        );
      }
      seenSectionIds.add(section.section_id);
    }
  }

  // An accompanying blueprint, when supplied, must belong to the same build.
  const blueprint = request.seo_content_blueprint;
  if (blueprint && blueprint.build_id !== request.build_id) {
    throw new PageContentContractInvalidError(
      `seo_content_blueprint build_id "${blueprint.build_id}" does not match request build_id "${request.build_id}"`,
    );
  }
}

/**
 * Website-Bot must be able to prove the package belongs to exactly the contract
 * it requested: identical ref, and a route set that matches one-for-one in the
 * contract's own order — no missing route, no extra route, no reordering.
 */
function assertPackageLineage(
  payload: StructuredContentPackageV1,
  contractRoutes: PageContentContractRoute[],
  contractRef: ReturnType<typeof refForArtifact>,
): void {
  if (!sameArtifactRef(payload.page_content_contract_ref, contractRef)) {
    throw new ArtifactLineageMismatchError(
      "Sealed package does not reference the exact PageContentContract supplied in the request",
    );
  }
  if (payload.routes.length !== contractRoutes.length) {
    throw new StructuredContentRouteMismatchError(
      `package has ${payload.routes.length} route(s); contract requires ${contractRoutes.length}`,
    );
  }
  for (let i = 0; i < contractRoutes.length; i++) {
    const expected = contractRoutes[i]!;
    const actual = payload.routes[i]!;
    if (actual.route_id !== expected.route_id) {
      throw new StructuredContentRouteMismatchError(
        `route ${i} is "${actual.route_id}"; contract requires "${expected.route_id}"`,
      );
    }
    if (actual.path !== expected.path) {
      throw new StructuredContentRouteMismatchError(
        `route "${expected.route_id}" path "${actual.path}" does not match contract path "${expected.path}"`,
      );
    }
  }
  if (
    !payload.validation.contract_passed ||
    !payload.validation.seo_blueprint_passed ||
    payload.validation.failed_requirements.length > 0 ||
    payload.validation.unsupported_claims.length > 0
  ) {
    throw new StructuredContentRouteMismatchError(
      "refusing to seal a package whose validation block records unresolved failures",
    );
  }
}

/**
 * Generate a single route's final content from ONLY its contract route. An
 * optional `repair` payload appends the specific failures to fix — scoping the
 * repair to this route without regenerating anything that already passed.
 *
 * Always called with `schemaRepairAttempts: 0`: this function performs EXACTLY
 * ONE actual LLM call, and the orchestrator owns the one total repair per
 * route (a route can therefore never consume more than two generation calls).
 * The caller-supplied counter records the call honestly for run evidence.
 */
async function generateRoute(
  llm: LlmService,
  request: StructuredContentRequest,
  contractRoute: PageContentContractRoute,
  repair?: {
    schema_failures?: SchemaFailure[];
    failed_requirements?: string[];
    unsupported_claims?: string[];
  },
  generationCalls?: LlmCallCounter,
): Promise<StructuredContentRoute> {
  const systemPrompt =
    "You are the sole owner of final website prose for one route. Write ONLY from " +
    "the supplied contract and allowed facts. Never invent facts or claims; every " +
    "claim must be backed by an allowed fact. Respect forbidden claims. Cover the " +
    "required topics/entities, answer the required questions, and satisfy the proof " +
    "requirements. Produce a metadata title and description that satisfy their " +
    "requirements. Produce exactly one section object per contract section_id (same " +
    "ids), plus faqs, internal links (including every required internal-link target), " +
    "and schema_content_inputs.\n\n" +
    STRUCTURED_CONTENT_OUTPUT_CONTRACT;

  const repairBlock = repair
    ? {
        repair_instructions: {
          note: "Your previous output failed validation. Fix ONLY the items below; keep everything else compliant.",
          schema_failures: repair.schema_failures ?? [],
          failed_requirements: repair.failed_requirements ?? [],
          remove_or_support_unsupported_claims: repair.unsupported_claims ?? [],
        },
      }
    : {};

  let userPrompt = JSON.stringify(
    {
      contract_route: contractRoute,
      required_internal_link_targets: contractRoute.internal_link_requirements.map(
        (link) => link.target_route_id,
      ),
      required_section_ids: contractRoute.sections.map((section) => section.section_id),
      ...repairBlock,
    },
    null,
    2,
  );
  if (repair) {
    // The repair prompt carries the exact output contract again — the model is
    // never asked to "fix" an output it was never taught the shape of.
    userPrompt += `\n\n---\nThe exact output contract again:\n${STRUCTURED_CONTENT_OUTPUT_CONTRACT}`;
  }

  return llm.executePolicyJson("STRUCTURED_CONTENT_GENERATION", {
    clientId: request.client_id,
    module: "build-intelligence",
    purpose: `structured-content:${contractRoute.route_id}`,
    systemPrompt,
    userPrompt,
    schemaRepairAttempts: 0,
    callCounter: generationCalls,
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

  const unexpected = parsed.sections
    .map((section) => section.section_id)
    .filter((id) => !contractSet.has(id));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected section_id(s) not in contract: ${unexpected.join(", ")}`);
  }
  const sections = contractSectionIds.map((id) => {
    const section = producedById.get(id);
    if (!section) throw new Error(`Missing required section_id: ${id}`);
    return section;
  });

  return { ...parsed, route_id: contractRoute.route_id, path: contractRoute.path, sections };
}

/**
 * content-validator.ts owns the semantic-validation call and is not part of
 * this change surface. This wrapper injects the shared actual-call counter into
 * its executePolicyJson call so run evidence can count semantic LLM calls
 * honestly — including any internal bounded repair the validator's own default
 * `schemaRepairAttempts: 1` may perform.
 */
function countingValidationLlm(llm: LlmService, calls: LlmCallCounter): LlmService {
  const target = llm;
  return {
    async executePolicyJson(
      operation: Parameters<LlmService["executePolicyJson"]>[0],
      args: Omit<Parameters<LlmService["executePolicyJson"]>[1], "callCounter">,
    ): Promise<unknown> {
      return target.executePolicyJson<unknown>(operation, { ...args, callCounter: calls });
    },
  } as unknown as LlmService;
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
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
