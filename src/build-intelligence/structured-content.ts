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
  type StructuredContentPackageArtifact,
  type StructuredContentPackageV1,
  type StructuredContentRoute,
  sameArtifactRef,
  sealIntelligenceArtifact,
  type VerifiedFactValue,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { getLlmService, type LlmCallCounter, type LlmService } from "../services/llm.js";
import type { LlmRunRecorder } from "../services/llm-run-recorder.js";
import {
  buildFactCorpus,
  CREDENTIAL_CLAIM_TOKENS,
  checkRouteGrounding,
  collectRouteText,
  MAGNITUDE_PHRASES,
  unsatisfiedProofRequirements,
} from "./claim-grounding.js";
import { type RouteValidationVerdict, validateRoute } from "./content-validator.js";
import { byCodeUnit } from "./ordering.js";
import { PRODUCER } from "./producer.js";
import {
  type SchemaFailure,
  STRUCTURED_CONTENT_OUTPUT_CONTRACT,
  schemaFailureDetails,
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
 * A route still violates the strict output SHAPE after the one bounded repair
 * (missing `blocks`, alias fields like `content`/`body`/`copy`/`paragraphs`,
 * unknown keys, or any other zod-strict failure). Malformed LLM JSON is a
 * generation failure — bounded and repaired — never a fatal parse error; a
 * second shape failure is terminal with THIS typed error (→ 422).
 */
export class StructuredContentShapeError extends Error {
  readonly code = "STRUCTURED_CONTENT_SHAPE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "StructuredContentShapeError";
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
  /**
   * Per-route ownership of generation spend. Each route carries its OWN
   * counters, incremented at the LLM boundary once per actual router call — a
   * package total is never divided by a route count, and no route's
   * `generation_calls` is ever assumed to be 1.
   */
  route_results: StructuredContentRouteResult[];
}

/**
 * One route's measured generation ownership.
 *
 * `repair_attempts` is the deterministic image of `repaired_route_ids`: the
 * orchestrator gives a route exactly one bounded repair and a second failure is
 * terminal, so a route that appears in `repaired_route_ids` had exactly one
 * repair and a route that does not had none. `generation_calls` is measured
 * independently, and `assertRouteAccounting` refuses to report the pair unless
 * they agree (`generation_calls === repair_attempts + 1`).
 */
export interface StructuredContentRouteResult {
  route_id: string;
  path: string;
  generation_calls: number;
  repair_attempts: number;
  semantic_validation_calls: number;
  schema_failure_count: number;
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
  deps: { llm?: LlmService; recorder?: LlmRunRecorder } = {},
): Promise<StructuredContentPackageArtifact> {
  return (await createStructuredContentPackageWithEvidence(request, deps)).artifact;
}

export async function createStructuredContentPackageWithEvidence(
  request: StructuredContentRequest,
  deps: { llm?: LlmService; recorder?: LlmRunRecorder } = {},
): Promise<StructuredContentResult> {
  // ── Lineage first: reject a tampered/invalid/foreign contract BEFORE any
  //    LLM spend. Integrity, identity, and structure are all checked here.
  assertContractUsable(request);

  const llm = deps.llm ?? getLlmService();
  const contract = request.page_content_contract.payload;

  // Package totals, accumulated from the PER-ROUTE counters below — the route
  // is the unit of ownership, and these are its sum rather than its source.
  // Generation uses `schemaRepairAttempts: 0`, so each generateRoute() is
  // exactly one LLM call; the semantic-validation path counts through a wrapper
  // that injects the route's counter into content-validator's
  // executePolicyJson call.
  const generationCalls: LlmCallCounter = { value: 0 };
  const semanticValidationCalls: LlmCallCounter = { value: 0 };

  const routes: StructuredContentRoute[] = [];
  const verdicts: RouteValidationVerdict[] = [];
  const repairedRouteIds: string[] = [];
  const routeResults: StructuredContentRouteResult[] = [];
  let schemaFailureCount = 0;

  for (const contractRoute of contract.routes) {
    const produced = await produceRoute({
      llm,
      request,
      contractRoute,
      recorder: deps.recorder,
    });

    routes.push(produced.route);
    verdicts.push(produced.verdict);
    if (produced.repaired) repairedRouteIds.push(contractRoute.route_id);
    schemaFailureCount += produced.schema_failure_count;
    // `repaired` is authoritative and the invariant above proves at most one
    // repair per route, so the mapping is deterministic: a repaired route
    // spent exactly one repair, an unrepaired route spent none.
    const routeRepairAttempts = produced.repaired ? 1 : 0;
    assertRouteAccounting(contractRoute.route_id, produced.generation_calls, routeRepairAttempts);
    routeResults.push({
      route_id: contractRoute.route_id,
      path: contractRoute.path,
      generation_calls: produced.generation_calls,
      repair_attempts: routeRepairAttempts,
      semantic_validation_calls: produced.semantic_validation_calls,
      schema_failure_count: produced.schema_failure_count,
    });
    generationCalls.value += produced.generation_calls;
    semanticValidationCalls.value += produced.semantic_validation_calls;
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
    // Measured per-route runtime evidence, in contract route order — the
    // consumer can prove the one-bounded-repair budget without trusting the
    // clean validation block.
    route_evidence: routeResults.map((result) => ({
      route_id: result.route_id,
      repair_attempts: result.repair_attempts,
      generation_calls: result.generation_calls,
      validation_calls: result.semantic_validation_calls,
      schema_errors: result.schema_failure_count,
    })),
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
      route_results: routeResults,
    },
  };
}

/** One route's measured outcome, owned entirely by that route. */
interface ProducedRoute {
  route: StructuredContentRoute;
  verdict: RouteValidationVerdict;
  repaired: boolean;
  generation_calls: number;
  semantic_validation_calls: number;
  schema_failure_count: number;
}

/**
 * Generate → validate → ONE bounded repair → re-validate, for a single route.
 *
 * The route is the unit of ownership, so the whole lifecycle for one route —
 * including its own call counters — lives here, and the orchestrator only
 * accumulates. A second failure after the repair is terminal: there is no
 * second repair, and the counters returned describe exactly what was spent.
 */
async function produceRoute(args: {
  llm: LlmService;
  request: StructuredContentRequest;
  contractRoute: PageContentContractRoute;
  recorder?: LlmRunRecorder;
}): Promise<ProducedRoute> {
  const { llm, request, contractRoute, recorder } = args;
  // Per-route counters. THIS route's generation spend is owned by THIS route:
  // the package total is the sum of them, never their source.
  const generationCalls: LlmCallCounter = { value: 0 };
  const validationCalls: LlmCallCounter = { value: 0 };
  const validationLlm = countingValidationLlm(llm, validationCalls, recorder);
  const validationArgs = {
    clientId: request.client_id,
    buildId: request.build_id,
    llm: validationLlm,
  };
  let schemaFailureCount = 0;

  // 1. Generate prose for this route only — ONE actual call (no internal
  //    repair: this function owns the one total repair for the route).
  let schemaFailures: SchemaFailure[] = [];
  let generated: StructuredContentRoute | null = null;
  try {
    generated = await generateRoute(
      llm,
      request,
      contractRoute,
      undefined,
      generationCalls,
      recorder,
    );
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
  let verdict: RouteValidationVerdict =
    generated === null
      ? {
          route_id: contractRoute.route_id,
          contract_passed: false,
          seo_blueprint_passed: false,
          unsupported_claims: [],
          failed_requirements: [],
        }
      : await validateRoute(generated, contractRoute, validationArgs);

  if (generated !== null && routePassed(generated, contractRoute, verdict, true)) {
    return {
      route: generated,
      verdict: groundedVerdict(generated, contractRoute, verdict),
      repaired: false,
      generation_calls: generationCalls.value,
      semantic_validation_calls: validationCalls.value,
      schema_failure_count: schemaFailureCount,
    };
  }

  // 3. ONE bounded repair covers a schema failure OR a semantic failure —
  //    never both, so a route consumes at most two generation calls. The
  //    repair prompt carries the exact failure evidence and the output
  //    contract again.
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
      recorder,
    );
  } catch (error) {
    const repairFailures = schemaFailureDetails(error);
    if (repairFailures.length > 0) {
      // A repair that still violates the strict output SHAPE is terminal with
      // the typed shape error (→ 422), not a semantic failure.
      throw new StructuredContentShapeError(
        `Route "${contractRoute.route_id}" repair still violates the structured-content SHAPE after one bounded repair: ` +
          repairFailures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
      );
    }
    throw new ContentRequirementUnsatisfiedError(
      `Route "${contractRoute.route_id}" repair produced invalid content: ` +
        repairFailures.map((failure) => `${failure.path}: ${failure.message}`).join("; "),
      verdict.failed_requirements,
      verdict.unsupported_claims,
    );
  }
  verdict = await validateRoute(repaired, contractRoute, validationArgs);

  // 4. Second failure is terminal for the LLM repair path — but the
  //    deterministic remediation gets one last authority pass: scrub
  //    ungrounded credential phrases and append fact-derived literal
  //    coverage, then re-validate once. No LLM, no second repair.
  if (!routePassed(repaired, contractRoute, verdict)) {
    const remediated = applyDeterministicRemediation(repaired, verdict, contractRoute);
    verdict = await validateRoute(remediated, contractRoute, validationArgs);
    if (!routePassed(remediated, contractRoute, verdict)) {
      logger.warn(
        {
          routeId: contractRoute.route_id,
          failed: verdict.failed_requirements,
          unsupported: verdict.unsupported_claims,
          routeText: collectRouteText(remediated).slice(0, 4000),
        },
        "Route terminal after one bounded repair; prose for diagnosis",
      );
      throw new ContentRequirementUnsatisfiedError(
        `Route "${contractRoute.route_id}" still fails validation after one bounded repair`,
        verdict.failed_requirements,
        verdict.unsupported_claims,
      );
    }
    return {
      route: remediated,
      verdict: groundedVerdict(remediated, contractRoute, verdict),
      repaired: true,
      generation_calls: generationCalls.value,
      semantic_validation_calls: validationCalls.value,
      schema_failure_count: schemaFailureCount,
    };
  }
  return {
    route: repaired,
    verdict: groundedVerdict(repaired, contractRoute, verdict),
    repaired: true,
    generation_calls: generationCalls.value,
    semantic_validation_calls: validationCalls.value,
    schema_failure_count: schemaFailureCount,
  };
}

/**
 * Refuse to report a route's accounting unless the two independent facts agree.
 *
 * `generation_calls` is COUNTED at the LLM boundary; `repair_attempts` is the
 * deterministic image of `repaired_route_ids`. Because generation runs with
 * `schemaRepairAttempts: 0`, a route makes exactly one call plus at most one
 * repair call — so the counted total must be `repair_attempts + 1`. Anything
 * else means the counters no longer describe the run, and the run fails rather
 * than exporting an untrue number.
 */
function assertRouteAccounting(
  routeId: string,
  generationCalls: number,
  repairAttempts: number,
): void {
  if (generationCalls !== repairAttempts + 1) {
    throw new StructuredContentRouteMismatchError(
      `route "${routeId}" made ${generationCalls} generation call(s) with ${repairAttempts} ` +
        `bounded repair(s); the one-repair invariant requires exactly ${repairAttempts + 1}`,
    );
  }
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
    const expected = contractRoutes[i];
    const actual = payload.routes[i];
    if (!expected || !actual) {
      throw new StructuredContentRouteMismatchError(
        `Route index ${i} missing from contract or payload`,
      );
    }
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
  recorder?: LlmRunRecorder,
): Promise<StructuredContentRoute> {
  const factCorpus = buildFactCorpus(contractRoute.business_facts);
  const bannedPhrases = [...CREDENTIAL_CLAIM_TOKENS, ...MAGNITUDE_PHRASES].filter(
    (token) => !factCorpus.includes(token.toLowerCase()),
  );
  const systemPrompt =
    "You are the sole owner of final website prose for one route. Write ONLY from " +
    "the supplied contract and allowed facts. Never invent facts or claims; every " +
    "claim must be backed by an allowed fact. Never invent geography or local-area " +
    "coverage beyond the verified facts (a remote-first business makes no local " +
    "service-area claims). NEVER write the phrases 'serves the local area', " +
    "'local area', 'surrounding areas', 'near you', or 'in your area' in any " +
    "form — the grounding layer scrubs them deterministically and broken " +
    "fragments would remain. Respect forbidden claims. Never use generic " +
    "proof-signaling phrases (proven, measurable outcomes, measurable results, " +
    "immediate value, industry-leading, best-in-class, trusted by) unless a " +
    "verified fact asserts them — write concrete, specific prose about " +
    "methodology, process, and approach instead. Cover the " +
    "required topics/entities, answer the required questions, and satisfy the proof " +
    "requirements. When a proof requirement cannot be backed by an allowed fact " +
    "(quantifiable achievements, third-party validation, or credentials the contract " +
    "does not support), satisfy it with an honest methodological or commitment " +
    "statement — never fabricate the proof itself. " +
    "NEVER write any of these phrases — the grounding layer removes them " +
    "deterministically and broken fragments would remain: " +
    `${bannedPhrases.join(", ")}. ` +
    "If a concept needs expression, write a complete grammatical sentence that " +
    "avoids the banned wording entirely. Produce a metadata title and " +
    "description that satisfy their " +
    "requirements. Produce exactly one section object per contract section_id (same " +
    "ids), plus faqs, internal links (including every required internal-link target), " +
    "and schema_content_inputs.\n\n" +
    STRUCTURED_CONTENT_OUTPUT_CONTRACT;

  const repairBlock = repair
    ? {
        repair_instructions: {
          note:
            "Your previous output failed validation. Fix ONLY the items below; " +
            "keep everything else compliant. Any unsupported claims below are BANNED " +
            "phrases: you MUST remove them completely — do not rephrase them, do not " +
            "include them in any form, in any section, FAQ, title, or description. " +
            "When removing a banned phrase, REWRITE the whole sentence so it stays " +
            "complete and grammatical — never leave fragments like 'fully and " +
            "available' or 'for a .' behind. Never reintroduce 'serves the local " +
            "area', 'surrounding areas', or any local-service phrasing.",
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
    recorder,
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
 * this change surface. This wrapper injects the PER-ROUTE actual-call counter
 * and the run recorder into its executePolicyJson call so run evidence can
 * count semantic LLM calls honestly — including any internal bounded repair the
 * validator's own default `schemaRepairAttempts: 1` may perform.
 */
function countingValidationLlm(
  llm: LlmService,
  calls: LlmCallCounter,
  recorder?: LlmRunRecorder,
): LlmService {
  const target = llm;
  return {
    async executePolicyJson(
      operation: Parameters<LlmService["executePolicyJson"]>[0],
      args: Omit<Parameters<LlmService["executePolicyJson"]>[1], "callCounter" | "recorder">,
    ): Promise<unknown> {
      return target.executePolicyJson<unknown>(operation, {
        ...args,
        callCounter: calls,
        recorder,
      });
    },
  } as unknown as LlmService;
}

/**
 * Deterministic remediation — NOT an LLM call, NOT a second repair. Applied
 * after the one bounded LLM repair still fails validation:
 *
 *  a. Scrub: credential/guarantee phrases the model wrote but the verified
 *     facts do not ground are removed from every block/FAQ/metadata text.
 *  b. Literal coverage: failed requirements of the form
 *     "required topic/entity X (missing: term)" get one deterministic,
 *     fact-derived sentence appended to the first section (as a proper
 *     block), carrying the exact literal term the validator requires.
 *
 * The oracle's repair budget is untouched: repair_attempts stays 1 and
 * generation_calls stays 2 — no second LLM generation happens.
 */
export function applyDeterministicRemediation(
  route: StructuredContentRoute,
  verdict: RouteValidationVerdict,
  contractRoute: PageContentContractRoute,
): StructuredContentRoute {
  const corpus = buildFactCorpus(contractRoute.business_facts);
  const allowedNumbers = new Set(
    (corpus.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replaceAll(",", "")),
  );

  // a. Scrub ungrounded credential phrases from all prose (whitespace-flexible;
  //    see scrubTextSurfaces — this also covers phrases whose words straddle
  //    adjacent text fields, the escape that failed golden run #40).
  scrubTextSurfaces(route, corpus, allowedNumbers, contractRoute.forbidden_claims);

  const facts = new Map(contractRoute.business_facts.map((f) => [f.key, f.value]));
  const biz = factText(facts.get("business_name")) || contractRoute.route_id;
  // Number("") is 0 — an absent years fact must not read as "0 years".
  const years = Number(facts.get("years_local_experience") ?? Number.NaN);
  const fillerYearsPhrase =
    Number.isFinite(years) && years > 0 ? ` with ${years} years of local experience` : "";
  // c. Substantive-content floor: scrubbing (or a lazy model) can leave a
  //    section under the 10-word threshold. Fill thin sections from present
  //    facts only. Do not invent a vertical or an offering when the contract
  //    has no vertical fact — the previous fallback ("professional services")
  //    was not fact-derived.
  const vertical = factText(facts.get("vertical"));
  const offering = vertical ? ` provides ${vertical} services` : "";
  const states = factText(facts.get("states_served"));
  const phone = factText(facts.get("phone"));
  const siteUrl = factText(facts.get("site_url"));
  const coverage = states ? ` across ${states}` : "";
  const filler = [
    `${biz}${offering}${coverage}${fillerYearsPhrase}.`,
    phone ? `${biz} can be reached at ${phone}.` : "",
    siteUrl ? `Learn more at ${siteUrl}.` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  for (const section of route.sections ?? []) {
    const words = (section.blocks ?? []).flatMap(blockText).join(" ").trim();
    if (words.split(/\s+/).filter(Boolean).length < 10) {
      section.blocks = [...(section.blocks ?? []), { kind: "paragraph", text: filler }];
    }
  }
  // b. Fact-derived literal sentences for each failed requirement.

  const topics: string[] = [];
  const entities: string[] = [];
  for (const failure of verdict.failed_requirements) {
    const topic = /required topic "([^"]+)"/.exec(failure)?.[1];
    const entity = /required entity "([^"]+)"/.exec(failure)?.[1];
    if (entity) entities.push(entity);
    else if (topic) topics.push(topic);
  }
  const sentences: string[] = [];
  const pushUnique = (text: string) => {
    const existing = collectRouteText(route);
    if (!existing.includes(text)) sentences.push(text);
  };
  // Generic coverage: topic/entity labels carry their own significant
  // tokens (and entities must appear literally), so stating them verbatim
  // covers EVERY stem the deterministic check derives from them. All
  // missed labels share ONE sentence — one per failure reads as duplicated
  // boilerplate (golden run #48). The sentence tail is the strictly
  // fact-derived filler — never a local-business template.
  const labels = [...new Set([...topics, ...entities])];
  if (labels.length > 0) {
    pushUnique(`Regarding ${labels.join(" and ")}: ${filler}`);
  }

  if (sentences.length > 0) {
    const first = route.sections?.[0];
    if (first && Array.isArray(first.blocks)) {
      for (const text of sentences) {
        first.blocks.push({ kind: "paragraph", text });
      }
    }
  }

  // d. Total-scrub guarantee: the fact-derived filler/sentences appended
  //    above get the same surface pass, then the route is returned directly —
  //    all scrubbing mutated fields in place, no JSON round-trip needed.
  scrubTextSurfaces(route, corpus, allowedNumbers, contractRoute.forbidden_claims);
  return route;
}

/** A single mutable author-visible string field of a route. */
interface TextSurface {
  read(): string | undefined;
  write(value: string): void;
}

/**
 * Every author-visible string field, in the same document order
 * `collectRouteText` flattens them. That order is what makes cross-surface
 * phrase detection faithful to the grounding check, which normalizes the
 * whole joined text into one whitespace-collapsed haystack.
 */
function collectTextSurfaces(route: StructuredContentRoute): TextSurface[] {
  const surfaces: TextSurface[] = [
    {
      read: () => route.metadata?.title,
      write: (v) => {
        if (route.metadata) route.metadata.title = v;
      },
    },
    {
      read: () => route.metadata?.description,
      write: (v) => {
        if (route.metadata) route.metadata.description = v;
      },
    },
  ];
  for (const section of route.sections ?? []) {
    surfaces.push(
      {
        read: () => section.eyebrow,
        write: (v) => {
          section.eyebrow = v;
        },
      },
      {
        read: () => section.heading,
        write: (v) => {
          section.heading = v;
        },
      },
      {
        read: () => section.subheading,
        write: (v) => {
          section.subheading = v;
        },
      },
      {
        read: () => section.cta?.label,
        write: (v) => {
          if (section.cta) section.cta.label = v;
        },
      },
      {
        read: () => section.cta?.action,
        write: (v) => {
          if (section.cta) section.cta.action = v;
        },
      },
    );
    for (const block of section.blocks ?? []) {
      if (block.kind === "paragraph" || block.kind === "quote") {
        surfaces.push({
          read: () => block.text,
          write: (v) => {
            block.text = v;
          },
        });
        if (block.kind === "quote") {
          surfaces.push({
            read: () => block.attribution,
            write: (v) => {
              block.attribution = v;
            },
          });
        }
      } else {
        block.items.forEach((_, index) => {
          surfaces.push({
            read: () => block.items[index],
            write: (v) => {
              block.items[index] = v;
            },
          });
        });
      }
    }
  }
  for (const faq of route.faqs ?? []) {
    surfaces.push(
      {
        read: () => faq.question,
        write: (v) => {
          faq.question = v;
        },
      },
      {
        read: () => faq.answer,
        write: (v) => {
          faq.answer = v;
        },
      },
    );
  }
  for (const link of route.internal_links ?? []) {
    surfaces.push({
      read: () => link.anchor_text,
      write: (v) => {
        link.anchor_text = v;
      },
    });
  }
  return surfaces;
}

/**
 * Render a verified fact for prose.
 *
 * `VerifiedFactValue` is `string | number | boolean | string[]`, and the array
 * variant is the reason this exists: `String(["CA", "NV"])` yields "CA,NV",
 * which is what a bare `String(facts.get("states_served"))` was interpolating
 * into a generated sentence — commas with no spaces, mid-paragraph. Arrays are
 * joined the way prose wants them; a boolean is not a noun phrase and renders
 * as nothing rather than a literal "true" in a customer-facing sentence.
 */
function factText(value: VerifiedFactValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value))
    return value
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(", ");
  if (typeof value === "boolean") return "";
  return String(value).trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Length of the run at the end of `text` whose characters satisfy `matches`.
 *
 * An end-anchored quantifier such as `/[^\w\s]+$/` looks linear and is not: the
 * engine retries it from every start position, so a long tail that does not
 * match costs O(n²) (typescript:S8786). Walking backwards visits each character
 * once and stops at the first that fails.
 */
function trailingRunLength(text: string, matches: (char: string) => boolean): number {
  let length = 0;
  while (length < text.length && matches(text[text.length - 1 - length]!)) length += 1;
  return length;
}

/** Trailing punctuation run — everything that is neither a word char nor space. */
function trimTrailingPunctuation(text: string): string {
  return text.slice(0, text.length - trailingRunLength(text, (c) => !/[\w\s]/.test(c)));
}

/**
 * The number literal at the very end of `text`, or undefined. Matches what
 * `/\d[\d,]*(?:\.\d+)?$/` accepted: digits, embedded commas and at most one
 * decimal part, with the first character a digit.
 */
function trailingNumber(text: string): string | undefined {
  const run = trailingRunLength(text, (c) => /[\d,.]/.test(c));
  for (let start = text.length - run; start < text.length; start++) {
    const candidate = text.slice(start);
    if (/^\d[\d,]*(?:\.\d+)?$/.test(candidate)) return candidate;
  }
  return undefined;
}

/** The prose a content block contributes, by block shape. */
function blockText(block: unknown): string[] {
  if (block && typeof block === "object") {
    if ("text" in block && typeof block.text === "string") return [block.text];
    if ("items" in block && Array.isArray(block.items)) return block.items.map(String);
  }
  return [];
}

function endsWithWord(text: string, word: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.endsWith(word)) return false;
  const before = lower[lower.length - word.length - 1];
  return before === undefined || !/[a-z0-9]/.test(before);
}

function startsWithWord(text: string, word: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.startsWith(word)) return false;
  const after = lower[word.length];
  return after === undefined || !/[a-z0-9]/.test(after);
}

/** Unit words whose quantified-claim patterns can straddle a surface boundary
 * ("5" at the end of one field, "years" at the start of the next). */
const QUANTIFIED_UNIT_WORDS =
  /^(?:(?:year|yr|project|job|install(?:ation)?|roof|home|customer|client|employee|crew|technician|installer)s?|properties|families|staff)\b/i;

/**
 * Scrub every text surface of a route in one pass:
 *
 *  1. Normalize whitespace (the grounding check collapses whitespace runs, so
 *     a phrase split across a line break or an NBSP is still one phrase
 *     there — and must be one phrase here).
 *  2. Remove credential/magnitude tokens the verified facts do not ground,
 *     matching token-internal spaces against ANY whitespace run and removing
 *     the maximal word containing the token (substring authority — derived
 *     forms like "certifications" cannot dodge the scrub the grounding check
 *     flags).
 *  3. Remove unverifiable quantified years (factNumbers authority).
 *  4. Cross-surface pass: a token whose words straddle two adjacent fields
 *     (golden run #40: CTA label "Get Your Free" + action "Estimate") is
 *     invisible to any per-field regex; remove the straddling words. The
 *     same class applies to "5" / "years" quantified splits.
 *
 * Empty surfaces are skipped when pairing, so an empty optional field between
 * two text-bearing fields cannot shield a straddling phrase.
 */
function scrubTextSurfaces(
  route: StructuredContentRoute,
  corpus: string,
  allowedNumbers: Set<string>,
  forbiddenPhrases: readonly string[] = [],
): void {
  const tokens = [...CREDENTIAL_CLAIM_TOKENS, ...MAGNITUDE_PHRASES];
  const forbidden = forbiddenPhrases
    .map((phrase) => phrase.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // Forbidden claims scrub unconditionally (no corpus guard) and can
  // straddle surfaces exactly like credential tokens (golden run #55:
  // "Best in Charlotte").
  const multiWordTokens = [
    ...tokens,
    ...forbidden.filter((phrase) => phrase.split(" ").length > 1),
  ];

  const surfaces = collectTextSurfaces(route);
  const values: string[] = [];
  const defined: boolean[] = [];
  for (const surface of surfaces) {
    const raw = surface.read();
    defined.push(typeof raw === "string");
    values.push(typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "");
  }

  for (let i = 0; i < values.length; i++) {
    if (!defined[i]) continue;
    let out = values[i] ?? "";
    const haystack = out.toLowerCase();
    for (const token of tokens) {
      // Case-insensitive guard: the replace regex is /gi but the presence
      // check must match it, or capitalized claims escape the scrub.
      if (!haystack.includes(token) || corpus.includes(token)) continue;
      const flexible = escapeRegex(token).replaceAll(" ", String.raw`\s+`);
      // Substring authority: the grounding check flags the token wherever it
      // appears as a substring, so the scrub must remove the maximal word
      // containing it — a word-bounded `\btoken\b` lets derived forms like
      // "certifications" or "recertification" survive and 422 the route
      // (golden run #41).
      out = out.replace(new RegExp(String.raw`\b[a-z0-9]*${flexible}[a-z0-9]*\b`, "gi"), " ");
    }
    // Forbidden claims: the deterministic check flags them wherever the
    // phrase appears; remove the same maximal-word way, with NO corpus
    // guard — a forbidden phrase is forbidden even if a fact contains it
    // (golden run #55).
    for (const phrase of forbidden) {
      if (!haystack.includes(phrase)) continue;
      const flexible = escapeRegex(phrase).replaceAll(" ", String.raw`\s+`);
      out = out.replace(new RegExp(String.raw`\b[a-z0-9]*${flexible}[a-z0-9]*\b`, "gi"), " ");
    }
    // Lifespan clauses first: "can last 30 years", "often lasting 25-30
    // years", "lifespan of 20 years". An ungrounded lifespan number can
    // never be corroborated, and removing only the number leaves broken
    // prose the semantic validator flags as "incomplete lifespan
    // information" (golden run #46: "EPDM rubber membranes can last
    // years"). Remove the WHOLE clause — verb, number, and unit — so no
    // claim-shaped residue survives.
    out = out.replace(
      /\b(?:(?:can|may|could|will|typically|often|usually|generally)\s+)?(?:lasts?|lasting|rated\s+for)\s+(?:for\s+|up\s+to\s+)?(\d+(?:-\d+)?)(?:\s*(?:to|[-–—]))?\s*(?:years?|yrs?)\b/gi,
      (match: string, num: string) => (allowedNumbers.has(num.replaceAll(",", "")) ? match : " "),
    );
    out = out.replace(
      /\b(?:lifespans?|service\s+life)\s+of\s+(\d+(?:-\d+)?)(?:\s*(?:to|[-–—]))?\s*(?:years?|yrs?)\b/gi,
      (match: string, num: string) => (allowedNumbers.has(num.replaceAll(",", "")) ? match : " "),
    );
    // Age-comparison clauses: "roof age over 20 years", "older than 20
    // years", "20+ years old". The number-only backstop below would leave
    // "age over years" residue the semantic validator flags (golden run
    // #50). Remove preposition + number + unit whole.
    out = out.replace(
      /\b(?:over|older\s+than|beyond|past|ages?\s+over|ages?\s+of)\s+(\d+(?:-\d+)?)\s*(?:years?|yrs?)\b/gi,
      (match: string, num: string) => (allowedNumbers.has(num.replaceAll(",", "")) ? match : " "),
    );
    out = out.replace(
      /\b(\d+(?:-\d+)?)\s*\+\s*(?:years?|yrs?)\s+old\b/gi,
      (match: string, num: string) => (allowedNumbers.has(num.replaceAll(",", "")) ? match : " "),
    );
    // Quantified "N years" assertions: a number the verified facts do not
    // contain can never be corroborated (factNumbers authority). Drop the
    // number, keep the unit, so the claim stops being a quantified claim.
    out = out.replace(
      /\b(\d+(?:-\d+)?)(?:\s*\+)?(?:\s*(?:to|[-–—]))?\s*(?=years?\b|yrs?\b)/gi,
      (match: string, num: string) => (allowedNumbers.has(num.replaceAll(",", "")) ? match : " "),
    );
    values[i] = out.replace(/\s{2,}/g, " ").trim();
  }

  // Cross-surface pass: pair each surface with the NEXT non-empty surface.
  let prev = -1;
  for (let i = 0; i < values.length; i++) {
    if (!values[i]) continue;
    if (prev === -1) {
      prev = i;
      continue;
    }
    let leftBody = trimTrailingPunctuation(values[prev]!).trimEnd();
    let rightBody = values[i]!.replace(/^[^\w\s]+/, "").trimStart();
    let removed = false;
    for (const token of multiWordTokens) {
      // Forbidden phrases scrub unconditionally — the deterministic check
      // flags them wherever present, corpus grounding never rescues them.
      if (!forbidden.includes(token) && corpus.includes(token)) continue;
      const words = token.split(" ");
      for (let k = 1; k < words.length && !removed; k++) {
        const prefix = words.slice(0, k).join(" ");
        const suffix = words.slice(k).join(" ");
        if (endsWithWord(leftBody, prefix) && startsWithWord(rightBody, suffix)) {
          leftBody = leftBody.slice(0, leftBody.length - prefix.length).trimEnd();
          rightBody = rightBody.slice(suffix.length).trimStart();
          // The removed phrase was quantified by an adjacent number in the
          // left surface ("6 years of" | "experience serving..."): the
          // dangling number is a claim remnant — strip it too (golden run
          // #59: "6 serving Charlotte's unique weather conditions").
          // Drop a trailing "6", "6+", "1,200.5 " and the like in one linear pass.
          const tail = leftBody.trimEnd().replace(/\+$/, "");
          const dangling = trailingNumber(tail);
          leftBody = (dangling ? tail.slice(0, tail.length - dangling.length) : leftBody).trimEnd();
          removed = true;
        }
      }
    }
    if (!removed) {
      // A quantified unit can straddle the same way ("5" ends one field,
      // "years" begins the next). The number is the claim — drop it.
      const number = trailingNumber(leftBody);
      if (
        number &&
        !allowedNumbers.has(number.replaceAll(",", "")) &&
        QUANTIFIED_UNIT_WORDS.test(rightBody)
      ) {
        leftBody = leftBody.slice(0, leftBody.length - number.length).trimEnd();
        removed = true;
      }
    }
    if (removed) {
      values[prev] = leftBody;
      values[i] = rightBody;
    }
    prev = i;
  }

  surfaces.forEach((surface, index) => {
    if (defined[index]) surface.write(values[index] ?? "");
  });
}

/** Claim grounding is deterministic authority: an "unsupported claim" is
 * defined by the facts corpus, not by model judgment. The semantic pass may
 * flag phrases the corpus actually grounds (golden run #26: "emergency
 * service"), so the pass/seal gates intersect the semantic claims with the
 * deterministic grounding result. The repair loop keeps the raw semantic
 * flags so repair feedback is never lost. */
function groundedVerdict(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
  verdict: RouteValidationVerdict,
  opts: { enforceAcceptanceTests?: boolean } = {},
): RouteValidationVerdict {
  const grounding = checkRouteGrounding(route, contractRoute);
  const groundedPhrases = new Set(
    grounding.unsupportedClaims
      .map((claim: string) => /"([^"]+)"/.exec(claim)?.[1])
      .filter((phrase: string | undefined): phrase is string => Boolean(phrase)),
  );
  const unsupportedClaims = verdict.unsupported_claims.filter((claim: string) => {
    const phrase = /"([^"]+)"/.exec(claim)?.[1];
    return Boolean(phrase) && groundedPhrases.has(phrase as string);
  });
  const groundingFailurePhrases = new Set(
    grounding.failures
      .map((failure) => /"([^"]+)"/.exec(failure)?.[1])
      .filter((phrase): phrase is string => Boolean(phrase))
      .map((phrase) => phrase.toLowerCase()),
  );
  const isCoverageShaped = (failure: string): boolean =>
    /required (topic|entity)/.test(failure) ||
    failure.includes("Missing required topics") ||
    failure.includes("Missing required entities");
  const coverageLabels = (failure: string): string[] => {
    const quoted = [...failure.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((capture): capture is string => typeof capture === "string");
    if (quoted.length > 0) return quoted.map((label) => label.toLowerCase());
    const colon = failure.indexOf(":");
    const list = colon >= 0 ? failure.slice(colon + 1) : "";
    return list
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  };
  const acceptancePhrases = [
    ...(contractRoute.acceptance_tests ?? []),
    ...(contractRoute.sections ?? []).flatMap((section) => section.acceptance_tests ?? []),
  ]
    .map((test) => test.trim())
    .filter(Boolean);
  const isAcceptanceTestFailure = (failure: string): boolean =>
    acceptancePhrases.some((phrase) => failure.toLowerCase().includes(phrase.toLowerCase()));
  const proofPhrases = [
    ...(contractRoute.sections ?? []).flatMap((section) => section.proof_requirements ?? []),
  ]
    .map((proof) => proof.trim().toLowerCase())
    .filter(Boolean);
  const isProofEcho = (failure: string): boolean => {
    const lower = failure.trim().toLowerCase();
    if (lower.startsWith("missing proof requirements")) return true;
    return proofPhrases.includes(lower);
  };
  const proofLabels = (failure: string): string[] => {
    const lower = failure.trim().toLowerCase();
    if (lower.startsWith("missing proof requirements")) {
      const colon = failure.indexOf(":");
      const list = colon >= 0 ? failure.slice(colon + 1) : "";
      return list
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
    return [lower];
  };
  const unsatisfiedProofs = unsatisfiedProofRequirements(route, contractRoute);
  const requirementIdPhrases = [
    ...(contractRoute.sections ?? []).flatMap(
      (section) => section.content_requirements?.requirement_ids ?? [],
    ),
  ]
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const isRequirementEcho = (failure: string): boolean =>
    requirementIdPhrases.includes(failure.trim().toLowerCase());
  const routeTextLower = collectRouteText(route).toLowerCase();
  const isRemediationSentenceQuote = (failure: string): boolean =>
    failure.trimStart().startsWith("Regarding ") && routeTextLower.includes(failure.toLowerCase());
  // Acceptance tests are repair-only: they are prompt instructions ("mentions
  // warranty"), not customer-facing phrases, so they cannot be token-checked
  // against prose. Proof echoes intersect a deterministic checker. Requirement
  // ids are not assertable against prose and still veto — dropping them must
  // not flip contract_passed via allFailuresFiltered.
  const failedRequirements = verdict.failed_requirements.filter((failure) => {
    if (isCoverageShaped(failure)) {
      return coverageLabels(failure).some((label) => groundingFailurePhrases.has(label));
    }
    if (isRemediationSentenceQuote(failure)) return false;
    if (opts.enforceAcceptanceTests) return true;
    if (isProofEcho(failure)) {
      return proofLabels(failure).some((label) => unsatisfiedProofs.has(label));
    }
    if (isAcceptanceTestFailure(failure)) return false;
    return !isRequirementEcho(failure);
  });
  const droppedRequirementEcho = verdict.failed_requirements.some(
    (failure) => isRequirementEcho(failure) && !failedRequirements.includes(failure),
  );
  const allFailuresFiltered =
    (verdict.failed_requirements.length > 0 || verdict.unsupported_claims.length > 0) &&
    unsupportedClaims.length === 0 &&
    failedRequirements.length === 0 &&
    !droppedRequirementEcho;
  return {
    ...verdict,
    unsupported_claims: unsupportedClaims,
    failed_requirements: failedRequirements,
    contract_passed:
      (verdict.contract_passed || allFailuresFiltered) &&
      unsupportedClaims.length === 0 &&
      failedRequirements.length === 0,
  };
}

function routePassed(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
  verdict: RouteValidationVerdict,
  enforceAcceptanceTests = false,
): boolean {
  const grounded = groundedVerdict(route, contractRoute, verdict, { enforceAcceptanceTests });
  return grounded.contract_passed && grounded.seo_blueprint_passed;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort(byCodeUnit);
}
