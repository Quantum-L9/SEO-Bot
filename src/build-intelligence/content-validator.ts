/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * Content validation (deterministic first, then semantic).
 *
 * Deterministic failures cannot be overridden by the semantic pass.
 */

import type {
  PageContentContractRoute,
  SEOContentBlueprintRoute,
  StructuredContentRoute,
  VerifiedBusinessFact,
} from "@quantum-l9/bot-interop";
import { getLlmService, type LlmService } from "../services/llm.js";
import { contentValidationVerdictSchema } from "./schema-guards.js";

export interface RouteValidationVerdict {
  route_id: string;
  contract_passed: boolean;
  seo_blueprint_passed: boolean;
  unsupported_claims: string[];
  failed_requirements: string[];
}

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[(?:insert|todo|tbd|placeholder)[^\]]*\]/i,
  /\{\{[^}]+\}\}/,
  /\bTODO\b/,
  /\bTBD\b/,
  /lorem ipsum/i,
];

const UNSUPPORTED_FACT_PATTERNS: ReadonlyArray<{
  id: string;
  re: RegExp;
  factKeys: readonly string[];
}> = [
  {
    id: "years_experience",
    re: /\b(?:decades of experience|\d+\+?\s+years(?:\s+of)?\s+experience)\b/i,
    factKeys: ["years_in_business", "years_experience", "years", "founded", "established"],
  },
  {
    id: "certification",
    re: /\b(?:certified|certification|licence|license|licensed|insured|bonded)\b/i,
    factKeys: ["certification", "certifications", "license", "licensed", "insured", "bonded"],
  },
  {
    id: "warranty",
    re: /\b(?:lifetime warranty|\d+-year warranty)\b/i,
    factKeys: ["warranty", "warranties", "guarantee"],
  },
  {
    id: "price",
    re: /\b(?:starting at|as low as|only \$?\d+|price[sd]? at)\b/i,
    factKeys: ["price", "pricing", "cost", "starting_price"],
  },
  {
    id: "award",
    re: /\b(?:award[- ]winning|best of|top[- ]rated|#1)\b/i,
    factKeys: ["award", "awards", "rating"],
  },
  {
    id: "crew_or_projects",
    re: /\b(?:\d+\s+(?:crews?|technicians?|employees?|projects?|roofs? (?:installed|replaced)))\b/i,
    factKeys: ["crew_size", "employees", "project_count", "projects_completed"],
  },
  {
    id: "response_time",
    re: /\b(?:same[- ]day|24\/7|respond(?:s|ing)? within)\b/i,
    factKeys: ["response_time", "availability", "hours"],
  },
];

function flattenRouteText(route: StructuredContentRoute): string {
  const parts: string[] = [
    route.metadata.title,
    route.metadata.description,
    ...route.sections.flatMap((section) => [
      section.eyebrow ?? "",
      section.heading ?? "",
      section.subheading ?? "",
      ...section.blocks.flatMap((block) => {
        if (block.kind === "paragraph" || block.kind === "quote") return [block.text];
        return block.items;
      }),
      section.cta?.label ?? "",
    ]),
    ...route.faqs.flatMap((faq) => [faq.question, faq.answer]),
    ...route.internal_links.map((link) => link.anchor_text),
  ];
  return parts.join("\n");
}

function factKeySet(facts: VerifiedBusinessFact[]): Set<string> {
  return new Set(facts.map((fact) => fact.key.toLowerCase()));
}

function hasSupportingFact(keys: readonly string[], facts: Set<string>): boolean {
  return keys.some((key) => facts.has(key.toLowerCase()));
}

function includesNormalized(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  if (h.includes(n)) return true;
  const stem = n.replace(/(ity|ies|ing|ed|s)$/i, "");
  if (stem.length >= 4 && h.includes(stem)) return true;
  const prefix = n.slice(0, 5);
  return prefix.length >= 4 && h.split(/\W+/).some((word) => word.startsWith(prefix));
}

/**
 * Deterministic contract checks for a single generated route against its
 * contract route. Returns failed-requirement strings (empty === pass).
 */
export function validateRouteDeterministic(
  route: StructuredContentRoute,
  contractRoute: PageContentContractRoute,
): string[] {
  const failures: string[] = [];

  if (route.route_id !== contractRoute.route_id) {
    failures.push(
      `${route.route_id}: route_id does not match contract (${contractRoute.route_id})`,
    );
  }
  if (route.path !== contractRoute.path) {
    failures.push(`${route.route_id}: path does not match contract (${contractRoute.path})`);
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

  const text = flattenRouteText(route);
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(text)) {
      failures.push(`${route.route_id}: placeholder content detected`);
      break;
    }
  }

  for (const section of route.sections) {
    const empty =
      section.blocks.length === 0 ||
      section.blocks.every((block) => {
        if (block.kind === "paragraph" || block.kind === "quote") return !block.text.trim();
        return block.items.every((item) => !item.trim());
      });
    if (empty) failures.push(`${route.route_id}: empty section "${section.section_id}"`);
  }

  const requiredTopics = [
    ...contractRoute.search_context.topics,
    ...contractRoute.sections.flatMap((section) => section.content_requirements.topics),
  ];
  const requiredEntities = [
    ...contractRoute.search_context.entities,
    ...contractRoute.sections.flatMap((section) => section.content_requirements.entities),
  ];
  for (const topic of requiredTopics) {
    if (!includesNormalized(text, topic)) {
      failures.push(`${route.route_id}: required topic not represented: ${topic}`);
    }
  }
  for (const entity of requiredEntities) {
    if (!includesNormalized(text, entity)) {
      failures.push(`${route.route_id}: required entity not represented: ${entity}`);
    }
  }

  return failures;
}

export function detectForbiddenClaims(
  route: StructuredContentRoute,
  forbiddenClaims: string[],
): string[] {
  const text = flattenRouteText(route).toLowerCase();
  return forbiddenClaims
    .map((claim) => claim.trim())
    .filter((claim) => claim.length > 0 && text.includes(claim.toLowerCase()));
}

export function detectUnsupportedClaims(
  route: StructuredContentRoute,
  facts: VerifiedBusinessFact[],
): string[] {
  const text = flattenRouteText(route);
  const keys = factKeySet(facts);
  const found: string[] = [];
  for (const pattern of UNSUPPORTED_FACT_PATTERNS) {
    if (pattern.re.test(text) && !hasSupportingFact(pattern.factKeys, keys)) {
      found.push(pattern.id);
    }
  }
  return found;
}

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
 * Deterministic failures force contract_passed=false and skip the semantic pass.
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
  const deterministicFailures = validateRouteDeterministic(route, contractRoute);
  const forbidden = detectForbiddenClaims(route, contractRoute.forbidden_claims);
  const unsupported = detectUnsupportedClaims(route, contractRoute.business_facts);
  const claimFailures = [
    ...forbidden.map((claim) => `${route.route_id}: forbidden claim: ${claim}`),
    ...unsupported.map((claim) => `${route.route_id}: unsupported claim: ${claim}`),
  ];

  if (deterministicFailures.length > 0 || claimFailures.length > 0) {
    return {
      route_id: contractRoute.route_id,
      contract_passed: false,
      seo_blueprint_passed: false,
      unsupported_claims: [...forbidden, ...unsupported],
      failed_requirements: [...deterministicFailures, ...claimFailures],
    };
  }

  const verdict = await validateRouteSemantics(route, contractRoute, args);
  return {
    route_id: contractRoute.route_id,
    contract_passed: verdict.contract_passed,
    seo_blueprint_passed: verdict.seo_blueprint_passed,
    unsupported_claims: verdict.unsupported_claims,
    failed_requirements: verdict.failed_requirements,
  };
}
