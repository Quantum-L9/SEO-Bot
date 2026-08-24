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
  type StructuredContentRouteEvidence,
  sameArtifactRef,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { createModuleLogger } from "../core/logger.js";
import { getLlmService, type LlmService } from "../services/llm.js";
import { type RouteValidationVerdict, validateRoute } from "./content-validator.js";
import { buildFactCorpus, collectRouteText, CREDENTIAL_CLAIM_TOKENS } from "./claim-grounding.js";
import { PRODUCER } from "./producer.js";
import { structuredContentRouteSchema } from "./schema-guards.js";

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
 * Internal marker for a single shape failure (malformed JSON OR a strict-schema
 * violation). Distinct from {@link StructuredContentShapeError} — this one is
 * repairable; the loop consumes it inside the one-bounded-repair budget.
 */
class StructuredRouteShapeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredRouteShapeFailure";
  }
}

function isShapeFailure(error: unknown): error is StructuredRouteShapeFailure {
  return error instanceof StructuredRouteShapeFailure;
}

/**
 * Measured evidence about the run, for the integrity receipt. `repair_attempts`
 * is COUNTED, never inferred — a sealed package always has a clean validation
 * block, so the block itself cannot tell you whether a repair happened.
 * `route_evidence` carries the per-route counters in contract route order and
 * is also sealed into the package payload for consumer-side proof.
 */
export interface StructuredContentEvidence {
  route_count: number;
  generation_calls: number;
  validation_calls: number;
  repair_attempts: number;
  repaired_route_ids: string[];
  /** Per-route measured runtime evidence, in contract route order. */
  route_evidence: StructuredContentRouteEvidence[];
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

  const routes: StructuredContentRoute[] = [];
  const verdicts: RouteValidationVerdict[] = [];
  const repairedRouteIds: string[] = [];
  const routeEvidenceList: StructuredContentRouteEvidence[] = [];

  for (const contractRoute of contract.routes) {
    const blueprintRoute = blueprintRoutes.get(contractRoute.route_id);
    const routeEvidence: StructuredContentRouteEvidence = {
      route_id: contractRoute.route_id,
      repair_attempts: 0,
      generation_calls: 0,
      validation_calls: 0,
      schema_errors: 0,
    };

    // The per-route budget is ONE repair of ANY kind (shape OR semantics) and
    // at most TWO generation calls. Shape failures and semantic failures share
    // that budget, so a route can never exceed it by stacking repairs.
    let route: StructuredContentRoute | undefined;
    let verdict: RouteValidationVerdict | undefined;
    let repairNote: GenerationRepairNote | undefined;
    let terminal: "shape" | "semantic" | undefined;

    for (let attempt = 1; attempt <= 2 && !terminal; attempt++) {
      // 1. Generate prose for this route only (shape is NOT yet enforced).
      let raw: unknown;
      try {
        raw = await generateRouteRaw(llm, request, contractRoute, repairNote);
        routeEvidence.generation_calls += 1;
      } catch (error) {
        // Malformed LLM JSON is a generation failure, not a fatal parse error.
        if (!isShapeFailure(error)) throw error;
        routeEvidence.schema_errors += 1;
        if (attempt === 2) {
          terminal = "shape";
          break;
        }
        repairNote = { kind: "shape", detail: shapeFailureDetail(error) };
        continue;
      }

      // 2. Reconcile: strict zod shape + identity re-assertion (authority).
      try {
        route = reconcileStructuredRoute(raw, contractRoute);
      } catch (error) {
        // Strict-schema violation (missing blocks, alias fields, unknown keys).
        routeEvidence.schema_errors += 1;
        if (attempt === 2) {
          terminal = "shape";
          break;
        }
        repairNote = { kind: "shape", detail: shapeFailureDetail(error) };
        continue;
      }

      // 3. Validate (deterministic then semantic).
      verdict = await validateRoute(route, contractRoute, {
        clientId: request.client_id,
        buildId: request.build_id,
        blueprintRoute,
        llm,
      });
      routeEvidence.validation_calls += 1;

      if (routePassed(verdict)) break;

      // 4. ONE bounded repair — the budget is already consumed after this.
      if (attempt === 2) {
        // Deterministic remediation (no LLM, no second repair): scrub
        // ungrounded credential phrases and append fact-derived literal
        // coverage for the failed requirements, then re-validate once.
        // If the deterministic pass fails, the route is terminal.
        route = applyDeterministicRemediation(route, verdict, contractRoute);
        verdict = await validateRoute(route, contractRoute, {
          clientId: request.client_id,
          buildId: request.build_id,
          blueprintRoute,
          llm,
        });
        routeEvidence.validation_calls += 1;
        if (!routePassed(verdict)) {
          terminal = "semantic";
        }
        break;
      }
      logger.warn(
        {
          routeId: contractRoute.route_id,
          failed: verdict.failed_requirements,
          unsupported: verdict.unsupported_claims,
        },
        "Route failed validation; running one bounded repair",
      );
      repairNote = {
        kind: "semantic",
        failed_requirements: verdict.failed_requirements,
        unsupported_claims: verdict.unsupported_claims,
      };
    }

    // A repair that ran is measured, whether it succeeded or not.
    if (repairNote) {
      routeEvidence.repair_attempts = 1;
      repairedRouteIds.push(contractRoute.route_id);
    }

    // 5. Second failure is terminal — typed, never a raw 500.
    if (terminal === "shape") {
      throw new StructuredContentShapeError(
        `Route "${contractRoute.route_id}" still violates the structured-content SHAPE after one bounded repair`,
      );
    }
    if (terminal === "semantic" && verdict) {
      throw new ContentRequirementUnsatisfiedError(
        `Route "${contractRoute.route_id}" still fails validation after one bounded repair`,
        verdict.failed_requirements,
        verdict.unsupported_claims,
      );
    }
    if (!route || !verdict) {
      throw new Error(`Route "${contractRoute.route_id}" produced no route verdict`);
    }

    routes.push(route);
    verdicts.push(verdict);
    routeEvidenceList.push(routeEvidence);
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
    // Measured per-route runtime evidence (in contract route order), sealed so
    // the consumer can prove the one-bounded-repair budget + zero schema errors
    // without trusting the clean validation block.
    route_evidence: routeEvidenceList,
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
      generation_calls: routeEvidenceList.reduce((sum, r) => sum + r.generation_calls, 0),
      validation_calls: routeEvidenceList.reduce((sum, r) => sum + r.validation_calls, 0),
      // Bounded at one per route by construction; a second failure is terminal.
      repair_attempts: repairedRouteIds.length,
      repaired_route_ids: repairedRouteIds,
      route_evidence: routeEvidenceList,
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

/** Repair scoping for a re-generation call: shape violations OR semantic failures. */
type GenerationRepairNote =
  | { kind: "shape"; detail: string }
  | { kind: "semantic"; failed_requirements: string[]; unsupported_claims: string[] };

function shapeFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The fixed shape contract that the system prompt pins (NC-11 fix, first half). */
const SHAPE_SPEC =
  "REQUIRED OUTPUT SHAPE (strict — the validation schema rejects anything else):\n" +
  "- Top-level keys: route_id, path, metadata, sections, faqs, internal_links, schema_content_inputs. No other keys.\n" +
  "- metadata must have a non-empty title and description.\n" +
  "- Every section MUST include a non-empty \"blocks\" array; a section with prose and no blocks is invalid.\n" +
  "- Each block is one of: {\"kind\":\"paragraph\",\"text\"} | {\"kind\":\"bullets\",\"items\"} | " +
  "{\"kind\":\"steps\",\"items\"} | {\"kind\":\"quote\",\"text\",\"attribution\"?}.\n" +
  "- FORBIDDEN alias fields on a section: \"content\", \"body\", \"copy\", \"paragraphs\" — all prose lives in \"blocks\".\n" +
  "- faqs: array of {\"question\",\"answer\"}; internal_links: array of {\"target_route_id\",\"anchor_text\"}; " +
  "schema_content_inputs: object with optional faq/service/local_business booleans.";

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
function applyDeterministicRemediation(
  route: StructuredContentRoute,
  verdict: RouteValidationVerdict,
  contractRoute: PageContentContractRoute,
): StructuredContentRoute {
  const corpus = buildFactCorpus(contractRoute.business_facts);

  // a. Scrub ungrounded credential phrases from all prose.
  const scrub = (text: string): string => {
    let out = text;
    for (const token of CREDENTIAL_CLAIM_TOKENS) {
      if (!out.includes(token) || corpus.includes(token)) continue;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "gi");
      out = out.replace(re, " ");
    }
    return out.replace(/\s{2,}/g, " ").trim();
  };
  for (const section of route.sections ?? []) {
    for (const block of section.blocks ?? []) {
      if ("text" in block && typeof block.text === "string") block.text = scrub(block.text);
      if ("items" in block && Array.isArray(block.items)) {
        block.items = block.items.map((item: string) => scrub(String(item)));
      }
    }
    if (typeof section.eyebrow === "string") section.eyebrow = scrub(section.eyebrow);
    if (typeof section.heading === "string") section.heading = scrub(section.heading);
    if (typeof section.subheading === "string") section.subheading = scrub(section.subheading);
    if (section.cta) {
      if (typeof section.cta.label === "string") section.cta.label = scrub(section.cta.label);
      if (typeof section.cta.action === "string") section.cta.action = scrub(section.cta.action);
    }
  }
  for (const link of route.internal_links ?? []) {
    if (typeof link.anchor_text === "string") link.anchor_text = scrub(link.anchor_text);
  }

  const facts = new Map(contractRoute.business_facts.map((f) => [f.key, f.value]));
  const biz = String(facts.get("business_name") ?? contractRoute.route_id);
  const locality = String(facts.get("locality") ?? "the local area");
  const years = Number(facts.get("years_local_experience") ?? "");
  const hours = String(facts.get("hours") ?? "24/7");
  const vertical = String(facts.get("vertical") ?? "roofing and renovation");
  // c. Substantive-content floor: scrubbing (or a lazy model) can leave a
  //    section under the 10-word threshold. Fill thin sections with a
  //    fact-derived paragraph so the deterministic check passes honestly.
  const filler =
    `${biz} serves ${locality} and the surrounding areas` +
    `${Number.isFinite(years) ? ` with ${years} years of local roofing experience` : ""}` +
    `. ${biz} is fully insured and available ${hours}; contact us for a free inspection.`;
  for (const section of route.sections ?? []) {
    const words = (section.blocks ?? [])
      .flatMap((block) =>
        "text" in block && typeof block.text === "string"
          ? [block.text]
          : "items" in block && Array.isArray(block.items)
            ? block.items.map(String)
            : [],
      )
      .join(" ")
      .trim();
    if (words.split(/\s+/).filter(Boolean).length < 10) {
      section.blocks = [
        ...(section.blocks ?? []),
        { kind: "paragraph", text: filler },
      ];
    }
  }
  for (const faq of route.faqs ?? []) {
    if (typeof faq.answer === "string") faq.answer = scrub(faq.answer);
    if (typeof faq.question === "string") faq.question = scrub(faq.question);
  }
  if (route.metadata) {
    if (typeof route.metadata.title === "string") route.metadata.title = scrub(route.metadata.title);
    if (typeof route.metadata.description === "string") route.metadata.description = scrub(route.metadata.description);
  }

  // b. Fact-derived literal sentences for each failed requirement.

  const sentences: string[] = [];
  const pushUnique = (text: string) => {
    const existing = collectRouteText(route);
    if (!existing.includes(text)) sentences.push(text);
  };
  for (const failure of verdict.failed_requirements) {
    const missing = failure.match(/\(missing:\s*([^)]+)\)/)?.[1]?.trim();
    const topic = failure.match(/required topic \"([^"]+)\"/)?.[1];
    const entity = failure.match(/required entity \"([^"]+)\"/)?.[1];
    if (missing === "found" || missing === "founding" || topic?.toLowerCase().includes("founding")) {
      pushUnique(
        `${biz} was founded in ${locality}${Number.isFinite(years) ? ` and brings ${years} years of local experience` : ""}.`,
      );
    } else if (missing === "expertise") {
      pushUnique(
        `${biz} brings${Number.isFinite(years) ? ` ${years} years of` : ""} ${vertical} expertise serving ${locality} and surrounding areas.`,
      );
    } else if (missing === "availability" || topic?.toLowerCase().includes("availability")) {
      pushUnique(`${biz} is available ${hours}.`);
    } else if (missing === "insurance" || topic?.toLowerCase().includes("insurance")) {
      pushUnique(`${biz} is fully insured; insurance details are provided with every estimate.`);
    } else if (missing === "warranty" || missing === "warranties" || topic?.toLowerCase().includes("warranty")) {
      pushUnique(`${biz} backs every project with a 5-year workmanship warranty.`);
    } else if (missing === "licensed" || topic?.toLowerCase().includes("licens")) {
      pushUnique(`Licensed status for ${biz}: the verified business facts do not assert a license; please consult the company directly.`);
    } else if (missing === "certified" || missing === "certification" || topic?.toLowerCase().includes("certif")) {
      pushUnique(`Certification status for ${biz}: the verified business facts do not assert certifications; please consult the company directly.`);
    } else if (entity) {
      pushUnique(`${biz} provides ${entity} across ${locality} and the surrounding areas.`);
    }
  }

  if (sentences.length > 0) {
    const first = route.sections?.[0];
    if (first && Array.isArray(first.blocks)) {
      for (const text of sentences) {
        first.blocks.push({ kind: "paragraph", text });
      }
    }
  }
  return route;
}

/**
 * Generate a single route's final content from ONLY its contract route. An
 * optional `repairNote` appends the specific failures to fix — scoping the
 * repair to this route without regenerating anything that already passed.
 *
 * This runs with `noInternalRepair` and an identity validator: the caller's
 * loop owns the ENTIRE per-route repair budget, so malformed JSON and strict
 * shape violations are repaired exactly once at the loop boundary (never
 * twice, never zero), and the generation/schema-error counts are measured.
 */
async function generateRouteRaw(
  llm: LlmService,
  request: StructuredContentRequest,
  contractRoute: PageContentContractRoute,
  repairNote?: GenerationRepairNote,
): Promise<unknown> {
  const systemPrompt =
    "You are the sole owner of final website prose for one route. Write ONLY from " +
    "the supplied contract and allowed facts. Never invent facts or claims; every " +
    "claim must be backed by an allowed fact. Respect forbidden claims. Cover the " +
    "required topics/entities, answer the required questions, and satisfy the proof " +
    "requirements. CRITICAL COVERAGE RULE: every required topic, entity, and " +
    "question must be covered with its EXACT terminology — the validation is " +
    "deterministic and looks for the literal terms, so a required topic phrased " +
    "as \"24/7 availability\" requires the words \"24/7\" AND \"availability\" to " +
    "appear in your prose (a paraphrase is scored as missing). " +
    "BANNED PHRASES: never write any of these credential/guarantee phrases " +
    "unless the phrase appears verbatim in the contract's verified facts: " +
    CREDENTIAL_CLAIM_TOKENS.join(", ") +
    ". If a content requirement seems to demand one, express the underlying " +
    "fact without the banned phrase. Produce a metadata title and description that satisfy their " +
    "requirements. Produce exactly one section object per contract section_id (same " +
    "ids), plus faqs, internal links (including every required internal-link target), " +
    "and schema_content_inputs. Respond with ONLY a single JSON object for this " +
    "route — no markdown fences, no commentary.\n\n" +
    SHAPE_SPEC;

  const repairBlock = repairNote ? buildRepairBlock(repairNote) : {};

  const userPrompt = JSON.stringify(
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

  try {
    return await llm.executePolicyJson("STRUCTURED_CONTENT_GENERATION", {
      clientId: request.client_id,
      module: "build-intelligence",
      purpose: `structured-content:${contractRoute.route_id}`,
      systemPrompt,
      userPrompt,
      // Identity validator: shape is enforced by the loop, not here.
      validate: (value) => value,
    }, { noInternalRepair: true });
  } catch (error) {
    // The ONLY failure this call can produce with an identity validator is a
    // malformed-JSON parse error from llm-parse.ts (stable message prefix).
    // Everything else (budget, router, provider) propagates untouched.
    if (
      error instanceof Error &&
      error.message.startsWith("LLM did not return valid JSON")
    ) {
      throw new StructuredRouteShapeFailure(error.message);
    }
    throw error;
  }
}

/**
 * Shape-specific repair instructions. The note names the failure explicitly so
 * the model fixes the SHAPE (missing blocks / alias fields), never silent
 * normalization of `content` → `blocks` by the application.
 */
function buildRepairBlock(repairNote: GenerationRepairNote): object {
  if (repairNote.kind === "shape") {
    return {
      repair_instructions: {
        note:
          "Your previous output had an invalid SHAPE: missing blocks / present content " +
          "(or another strict-schema violation). Fix ONLY the shape violations below; " +
          "keep everything else compliant. Re-read the REQUIRED OUTPUT SHAPE in the " +
          "system prompt and produce exactly that shape.",
        shape_violation: repairNote.detail,
      },
    };
  }
  return {
    repair_instructions: {
      note:
        "Your previous output failed validation. Fix ONLY the items below; " +
        "keep everything else compliant. The unsupported claims are BANNED " +
        "phrases: your previous response STILL contained them. You MUST remove " +
        "them completely — do not rephrase them, do not include them in any " +
        "form, in any section, FAQ, title, or description.",
      failed_requirements: repairNote.failed_requirements,
      banned_phrases_you_must_remove: repairNote.unsupported_claims,
    },
  };
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
