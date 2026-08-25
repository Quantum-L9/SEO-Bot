/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 5 — Content validation (deterministic first, then semantic)
 *
 * DETERMINISTIC (zero tokens): route IDs match the contract exactly, section IDs
 * match exactly, no unexpected routes/sections, required metadata present,
 * required internal-link targets represented.
 *
 * SEMANTIC (CONTENT_VALIDATION, requiresSearch=false): required topic satisfied,
 * entity handled, question answered, proof requirement respected, unsupported-
 * and forbidden-claim detection, search-intent alignment.
 *
 * Every route yields an explicit verdict; the producer aggregates them into the
 * sealed `validation` block and scopes any repair to the failing route(s).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type {
  PageContentContractRoute,
  SEOContentBlueprintRoute,
  StructuredContentRoute,
} from "@quantum-l9/bot-interop";
import { getLlmService, type LlmService } from "../services/llm.js";
import { checkRouteGrounding } from "./claim-grounding.js";
import { contentValidationVerdictSchema } from "./schema-guards.js";

export interface RouteValidationVerdict {
  route_id: string;
  contract_passed: boolean;
  seo_blueprint_passed: boolean;
  unsupported_claims: string[];
  failed_requirements: string[];
}

/**
 * Deterministic contract checks for a single generated route against its
 * contract route. Returns a list of failed-requirement strings (empty === pass).
 * Structural identity (route_id + exact section_id set) is validated here as a
 * defence-in-depth backstop even though generation already enforces it.
 */
export function validateRouteDeterministic(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): string[] {
  return deterministicVerdict(route, contractRoute).failed_requirements;
}

/**
 * Full deterministic verdict for one route: structural contract checks plus
 * zero-token claim grounding. Unsupported factual claims are reported
 * separately from requirement failures because the sealed `validation` block
 * and the bounded repair both distinguish them.
 */
export function deterministicVerdict(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): { failed_requirements: string[]; unsupported_claims: string[] } {
  const failures = structuralFailures(route, contractRoute);
  const grounding = checkRouteGrounding(route, contractRoute);
  return {
    failed_requirements: [...failures, ...grounding.failures],
    unsupported_claims: grounding.unsupportedClaims,
  };
}

function structuralFailures(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): string[] {
  const failures: string[] = [];

  if (route.route_id !== contractRoute.route_id) {
    failures.push(
      `${route.route_id}: route_id does not match contract (${contractRoute.route_id})`,
    );
  }

  const contractSectionIds = contractRoute.sections.map((section) => section.section_id).sort();
  const routeSectionIds = route.sections.map((section) => section.section_id).sort();
  const contractSet = new Set(contractSectionIds);
  const routeSet = new Set(routeSectionIds);
  for (const id of routeSectionIds) {
    if (!contractSet.has(id))
      failures.push(`${route.route_id}: unexpected section_id "${id}" not in contract`);
  }
  for (const id of contractSectionIds) {
    if (!routeSet.has(id)) failures.push(`${route.route_id}: missing required section_id "${id}"`);
  }

  if (!route.metadata.title.trim()) failures.push(`${route.route_id}: missing metadata.title`);
  if (!route.metadata.description.trim())
    failures.push(`${route.route_id}: missing metadata.description`);

  const linkedTargets = new Set(route.internal_links.map((link) => link.target_route_id));
  for (const requirement of contractRoute.internal_link_requirements) {
    if (!linkedTargets.has(requirement.target_route_id)) {
      failures.push(
        `${route.route_id}: missing required internal link to "${requirement.target_route_id}"`,
      );
    }
  }

  return failures;
}

/**
 * Semantic validation for a single route (CONTENT_VALIDATION op, no search).
 * The model receives only the generated route + the contract requirements +
 * the allowed facts (+ the blueprint route when available) — never raw
 * competitor pages. It returns a per-route verdict.
 */
export async function validateRouteSemantics(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
  args: {
    clientId: string;
    buildId: string;
    blueprintRoute?: SEOContentBlueprintRoute;
    llm?: LlmService;
  },
): Promise<import("./schema-guards.js").ContentValidationVerdict> {
  const llm = args.llm ?? getLlmService();
  const systemPrompt =
    "You are a strict SEO content QA validator. Judge ONLY whether the generated " +
    "content satisfies the contract: required topics covered, entities handled, " +
    "questions answered, proof requirements respected, search intent aligned, and " +
    "no unsupported or forbidden claims. A claim is unsupported if it is not backed " +
    "by an allowed fact. Do not rewrite content. Respond with ONLY a JSON object: " +
    '{"seo_blueprint_passed":bool,"contract_passed":bool,"unsupported_claims":[...],' +
    '"failed_requirements":[...]} — no prose, no markdown fences.';

  const userPrompt = JSON.stringify(
    {
      generated_route: route,
      contract_route: {
        route_id: contractRoute.route_id,
        search_context: contractRoute.search_context,
        forbidden_claims: contractRoute.forbidden_claims,
        acceptance_tests: contractRoute.acceptance_tests,
        allowed_facts: contractRoute.business_facts,
        sections: contractRoute.sections.map((section) => ({
          section_id: section.section_id,
          objective: section.objective,
          content_requirements: section.content_requirements,
          allowed_fact_ids: section.allowed_fact_ids,
          proof_requirements: section.proof_requirements,
        })),
      },
      blueprint_route: args.blueprintRoute ?? null,
    },
    null,
    2,
  );

  return llm.executePolicyJson("CONTENT_VALIDATION", {
    clientId: args.clientId,
    module: "build-intelligence",
    purpose: `content-validation:${contractRoute.route_id}`,
    systemPrompt,
    userPrompt,
    validate: (value) => contentValidationVerdictSchema.parse(value),
  });
}

/**
 * Full per-route verdict: deterministic failures fold into the semantic verdict.
 * Deterministic failures force `contract_passed=false` and are appended to
 * `failed_requirements`, and — to conserve tokens — a route that fails
 * deterministically is not sent to the semantic pass (it will be repaired and
 * re-validated regardless).
 */
export async function validateRoute(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
  args: {
    clientId: string;
    buildId: string;
    blueprintRoute?: SEOContentBlueprintRoute;
    llm?: LlmService;
  },
): Promise<RouteValidationVerdict> {
  const deterministic = deterministicVerdict(route, contractRoute);
  if (deterministic.failed_requirements.length > 0 || deterministic.unsupported_claims.length > 0) {
    return {
      route_id: contractRoute.route_id,
      contract_passed: false,
      seo_blueprint_passed: false,
      unsupported_claims: deterministic.unsupported_claims,
      failed_requirements: deterministic.failed_requirements,
    };
  }

  const verdict = await validateRouteSemantics(route, contractRoute, args);
  // Semantic validation is secondary authority: it may only ADD failures, never
  // clear a deterministic one (there are none left at this point) and never
  // turn a failing verdict into a pass. Unsupported-claim GROUNDING is applied
  // by the caller at the pass/seal gates (groundedVerdict in
  // structured-content.ts) so the semantic flags still reach the repair loop.
  return {
    route_id: contractRoute.route_id,
    contract_passed: verdict.contract_passed,
    seo_blueprint_passed: verdict.seo_blueprint_passed,
    unsupported_claims: verdict.unsupported_claims,
    failed_requirements: verdict.failed_requirements,
  };
}
