/* L9_META
 * layer: test
 * role: test_fixture
 * status: active
 */

/**
 * Shared doubles for structured-content tests that drive the real producer.
 *
 * `routePromptModel` stands in for the LLM: semantic validation always passes,
 * and each generation call is answered by `answer` from the route id and the
 * parsed prompt it was given (first draft or repair). `expectNoRepeatedBodyCopy`
 * asserts the site-quality rule over a sealed package: no body unit of 8+ words
 * repeats anywhere.
 */

import type { StructuredContentRoute } from "@quantum-l9/bot-interop";
import { expect } from "vitest";
import {
  contentUnits,
  DUPLICATE_SIMILARITY,
  isHeadingUnit,
  shingleSimilarity,
} from "../../../src/build-intelligence/content-duplication.js";
import type { ContentValidationVerdict } from "../../../src/build-intelligence/schema-guards.js";
import type { LlmService } from "../../../src/services/llm.js";

const pass: ContentValidationVerdict = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};

/** The parts of a structured-content generation prompt these tests read. */
export interface RoutePrompt {
  repair_instructions?: { failed_requirements: string[] };
  do_not_reuse_from_earlier_routes?: {
    sentences: Array<{ route_id: string; location: string; text: string }>;
  };
  route_specific_framing?: {
    shared_components: Array<{ section_id: string; also_on_routes: string[] }>;
    repeated_faq_questions: Array<{ question: string; also_on_routes: string[] }>;
  };
}

/** One generation call: which route, and the prompt the model saw. */
export interface RoutePromptCall {
  routeId: string;
  prompt: RoutePrompt;
  repair: boolean;
  /** Repair evidence lines (empty on a first draft). */
  evidence: string[];
  /** Exact earlier-route sentences the prompt said not to reuse. */
  doNotReuse: string[];
}

export function routePromptModel(answer: (call: RoutePromptCall) => StructuredContentRoute): {
  llm: LlmService;
  calls: RoutePromptCall[];
} {
  const calls: RoutePromptCall[] = [];
  const llm = {
    async executePolicyJson(
      operation: string,
      args: {
        purpose: string;
        userPrompt: string;
        validate: (value: unknown) => unknown;
        callCounter?: { value: number };
      },
    ) {
      if (args.callCounter) args.callCounter.value += 1;
      if (operation === "CONTENT_VALIDATION") return args.validate(pass);
      const prompt = JSON.parse(args.userPrompt.split("\n\n---\n")[0] ?? "{}") as RoutePrompt;
      const call: RoutePromptCall = {
        routeId: args.purpose.split(":")[1] as string,
        prompt,
        repair: Boolean(prompt.repair_instructions),
        evidence: prompt.repair_instructions?.failed_requirements ?? [],
        doNotReuse: (prompt.do_not_reuse_from_earlier_routes?.sentences ?? []).map(
          (sentence) => sentence.text,
        ),
      };
      calls.push(call);
      return args.validate(answer(call));
    },
  } as unknown as LlmService;
  return { llm, calls };
}

/** No body unit of 8+ words is repeated (Jaccard ≥ the limit) anywhere in `routes`. */
export function expectNoRepeatedBodyCopy(routes: readonly StructuredContentRoute[]): void {
  const units = routes
    .flatMap((route) => contentUnits(route))
    .filter((unit) => !isHeadingUnit(unit));
  for (const [index, unit] of units.entries()) {
    for (const other of units.slice(index + 1)) {
      const similarity = shingleSimilarity(unit.text, other.text);
      expect(
        similarity === null || similarity < DUPLICATE_SIMILARITY,
        `${unit.route_id} ${unit.location} repeats ${other.route_id} ${other.location}`,
      ).toBe(true);
    }
  }
}
