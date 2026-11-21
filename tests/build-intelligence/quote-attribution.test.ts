/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * QAP canary10 regression: the quote-attribution rule. Fake transports only.
 *
 * canary10's /revops page carried the quote "The operational test is whether a
 * team can follow through on a prioritized list with reproducible evidence
 * behind each choice, and then measure what actually closed." attributed to
 * "Quantum AI Partners methodology statement": the business quoting itself and
 * calling it a source. The requirement checklist now holds one deterministic
 * rule, read by the validator, the prompt and the repair alike: a quote needs
 * an attribution that names a source in the contract's verified facts. No
 * attribution, the business itself, or a self-reference ("methodology",
 * "statement", "philosophy", ...) fails, and the repair rewrites the quote as a
 * paragraph or drops it. It never supplies an attribution.
 */

import {
  type ArtifactRef,
  type PageContentContractArtifact,
  type PageContentContractRoute,
  type PageContentContractV1,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";

type BusinessFact = PageContentContractRoute["business_facts"][number];

import {
  checkRouteGrounding,
  QUOTE_SELF_REFERENCE_TERMS,
  quoteAttributionProblem,
  routeRequirementChecklist,
} from "../../src/build-intelligence/claim-grounding.js";
import {
  createStructuredContentPackageWithEvidence,
  type RepairEvidenceItem,
  renderRequirementChecklist,
} from "../../src/build-intelligence/structured-content.js";
import { routePromptModel } from "./fixtures/route-prompt-model.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CANARY_QUOTE =
  "The operational test is whether a team can follow through on a prioritized list with reproducible evidence behind each choice, and then measure what actually closed.";
const CANARY_ATTRIBUTION = "Quantum AI Partners methodology statement";

const fact = (key: string, value: string): BusinessFact => ({
  fact_id: `f-${key}`,
  key,
  value,
  verified: true,
  source_refs: ["spec"],
});

const BASE_FACTS = [
  fact("company_name", "Quantum AI Partners"),
  fact("delivery_model", "remote-first consulting"),
];
const PRESS_FACTS = [...BASE_FACTS, fact("press_mention", "Featured in Harvard Business Review")];

function contractRoute(facts: readonly BusinessFact[]): PageContentContractRoute {
  const section = (sectionId: string) => ({
    section_id: sectionId,
    component_class: sectionId,
    objective: `explain ${sectionId}`,
    slots: ["service_overview" as const],
    content_requirements: {
      requirement_ids: [`revops-${sectionId}`],
      topics: ["revenue operations"],
      entities: ["revenue operations"],
      questions: [],
    },
    allowed_fact_ids: facts.map((item) => item.fact_id),
    proof_requirements: [],
    acceptance_tests: [],
  });
  return {
    route_id: "revops",
    path: "/revops",
    purpose: "revenue operations",
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: "revenue operations consulting",
      supporting_queries: [],
      topics: ["revenue operations"],
      entities: ["revenue operations"],
    },
    metadata_requirements: { title: ["name the service"], description: ["<160 chars"] },
    business_facts: [...facts],
    sections: [section("hero"), section("proof")],
    internal_link_requirements: [],
    forbidden_claims: [],
    acceptance_tests: [],
  };
}

const dummyRef: ArtifactRef = {
  artifact_type: "website_build_blueprint",
  artifact_id: "x",
  payload_digest: "y",
};

function contract(facts: readonly BusinessFact[]): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: [contractRoute(facts)],
  };
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "qap",
    build_id: "qap-canary10",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

type ProofBlock = StructuredContentRoute["sections"][number]["blocks"][number];

/** The /revops route; `proof` is the block the canary put its quote in. */
function revopsRoute(proof: ProofBlock): StructuredContentRoute {
  return {
    route_id: "revops",
    path: "/revops",
    metadata: {
      title: "Quantum AI Partners revenue operations",
      description: "Revenue operations consulting, delivered remote-first.",
    },
    sections: [
      {
        section_id: "hero",
        heading: "Revenue operations that hold up",
        blocks: [
          {
            kind: "paragraph",
            text: "Quantum AI Partners runs revenue operations engagements as remote-first consulting for growing sales teams.",
          },
        ],
      },
      { section_id: "proof", heading: "How revenue operations is judged", blocks: [proof] },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
}

const canaryQuote: ProofBlock = {
  kind: "quote",
  text: `${CANARY_QUOTE} That is how revenue operations is judged.`,
  attribution: CANARY_ATTRIBUTION,
};

function quoteFailures(route: StructuredContentRoute, facts: readonly BusinessFact[]): string[] {
  const contractRouteValue = contractRoute(facts);
  return checkRouteGrounding(route, contractRouteValue).failures.filter((failure) =>
    failure.includes("unsupported attribution"),
  );
}

interface RepairPrompt {
  repair_instructions?: { repair_evidence: RepairEvidenceItem[] };
  requirement_checklist: { route_instructions: string[] };
}

describe("quote attribution — the checklist rule", () => {
  const rules = routeRequirementChecklist(contractRoute(PRESS_FACTS)).quote_attribution;

  it("rejects the canary10 /revops quote: the business quoting its own methodology", () => {
    expect(quoteAttributionProblem(CANARY_ATTRIBUTION, rules)).toBe("names the business itself");
    expect(quoteFailures(revopsRoute(canaryQuote), BASE_FACTS)).toEqual([
      `revops: quote at sections.proof.blocks[0] has an unsupported attribution "${CANARY_ATTRIBUTION}" (names the business itself)`,
    ]);
  });

  it.each([
    [undefined, "no attribution"],
    ["   ", "no attribution"],
    ["Quantum AI Partners", "names the business itself"],
    ["Our methodology", 'is a self-reference ("methodology")'],
    ["Mission statement", 'is a self-reference ("statement")'],
    ["The team philosophy", 'is a self-reference ("philosophy")'],
    ["Jane Doe, VP Sales", "is not in the contract's evidence"],
  ])("attribution %j fails: %s", (attribution, problem) => {
    expect(quoteAttributionProblem(attribution, rules)).toBe(problem);
  });

  it("passes a quote whose attribution is a source present in the verified facts", () => {
    expect(quoteAttributionProblem("Harvard Business Review", rules)).toBeNull();
    expect(quoteAttributionProblem("— Harvard Business Review. ", rules)).toBeNull();
    const sourced: ProofBlock = {
      kind: "quote",
      text: "Revenue operations is now a board-level discipline for growing sales teams.",
      attribution: "Harvard Business Review",
    };
    expect(quoteFailures(revopsRoute(sourced), PRESS_FACTS)).toEqual([]);
  });

  it("the same rule reaches the prompt: the checklist forbids self-attribution", () => {
    const checklist = routeRequirementChecklist(contractRoute(BASE_FACTS));
    const rendered = renderRequirementChecklist(checklist).route_instructions.join("\n");
    expect(rendered).toContain("A quote block needs an attribution");
    expect(rendered).toContain("Never invent an attribution");
    for (const term of ["methodology", "statement", "philosophy"]) {
      expect(QUOTE_SELF_REFERENCE_TERMS).toContain(term);
      expect(rendered).toContain(term);
    }
  });
});

describe("quote attribution — the bounded repair (real producer, fake model)", () => {
  it("repairs the canary quote into a paragraph and never invents an attribution", async () => {
    const { llm, calls } = routePromptModel((call) => {
      if (!call.repair) return revopsRoute(canaryQuote);
      // A compliant model follows the repair instruction: same words, paragraph block.
      return revopsRoute({ kind: "paragraph", text: canaryQuote.text });
    });

    const result = await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-canary10", page_content_contract: contract(BASE_FACTS) },
      { llm },
    );

    expect(calls.map((call) => call.repair)).toEqual([false, true]);
    const repairPrompt = calls[1]?.prompt as unknown as RepairPrompt;
    const evidence = repairPrompt.repair_instructions?.repair_evidence ?? [];
    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "unsupported_quote_attribution",
        section_ids: ["proof"],
        must_write: [],
      }),
    ]);
    const instruction = evidence[0]?.instruction ?? "";
    expect(instruction).toContain("paragraph");
    expect(instruction).toContain("Never invent");

    const sealed = result.artifact.payload.routes[0];
    const blocks = sealed?.sections.flatMap((section) => section.blocks) ?? [];
    expect(blocks.some((block) => block.kind === "quote")).toBe(false);
    expect(blocks).toContainEqual({ kind: "paragraph", text: canaryQuote.text });
    expect(JSON.stringify(sealed)).not.toContain(CANARY_ATTRIBUTION);
  });
});
