/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * The prompt and repair must ask for exactly what the validator checks.
 *
 * QAP canary qap-canary6-20261121T040945Z failed "/" with:
 * - `section "spec-component-7" has no substantive content` — the FAQ section,
 *   whose Q&A the output contract puts ONLY in route-level `faqs` (blocks: []),
 *   while the substance check counted only the section's own blocks;
 * - `required entity "Relationship graph" is not represented` — the prompt said
 *   only "cover the required entities"; the model wrote "relationship
 *   intelligence", and the check is literal.
 *
 * FAQ rule chosen (a): an FAQ section's substance counts the route-level faqs
 * it renders. The 10-word floor, literal entities and the single repair stay.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PageContentContractArtifact,
  type PageContentContractRoute,
  type PageContentContractV1,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRouteGrounding,
  faqSectionIds,
  isFaqContractSection,
} from "../../src/build-intelligence/claim-grounding.js";
import { createDeepSeekBuildIntelligenceLlm } from "../../src/build-intelligence/deepseek-llm.js";
import {
  createStructuredContentPackageWithEvidence,
  entityPlacements,
} from "../../src/build-intelligence/structured-content.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ENTITIES = ["CRM", "Relationship graph", "RevOps"];
const dummyRef = {
  artifact_type: "website_build_blueprint" as const,
  artifact_id: "a".repeat(64),
  schema: "x",
  content_digest: "b".repeat(64),
};

function section(
  sectionId: string,
  componentClass: string,
  slot: string,
  entities: string[] = [],
): PageContentContractRoute["sections"][number] {
  return {
    section_id: sectionId,
    component_class: componentClass,
    objective: `explain ${componentClass}`,
    slots: [slot],
    content_requirements: {
      requirement_ids: [`${sectionId}-r`],
      topics: [],
      entities,
      questions: [],
    },
    allowed_fact_ids: [],
    proof_requirements: [],
    acceptance_tests: [],
  } as unknown as PageContentContractRoute["sections"][number];
}

/** QAP "/" shape: hero, process (requires the three entities), FAQ. */
function homeContract(): PageContentContractRoute {
  return {
    route_id: "home",
    path: "/",
    purpose: "primary landing",
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: "crm transformation",
      supporting_queries: [],
      topics: [],
      entities: [],
    },
    metadata_requirements: { title: [], description: [] },
    business_facts: [
      {
        fact_id: "f1",
        key: "business_name",
        value: "Quantum AI Partners",
        verified: true,
        source_refs: ["spec"],
      },
    ],
    sections: [
      section("spec-component-1", "hero", "primary_offer"),
      section("spec-component-4", "process", "process", ENTITIES),
      section("spec-component-7", "faq", "faq"),
    ],
    internal_link_requirements: [],
    forbidden_claims: [],
    acceptance_tests: [],
  } as unknown as PageContentContractRoute;
}

function contractArtifact(): PageContentContractArtifact {
  const payload = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: [homeContract()],
  } as unknown as PageContentContractV1;
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "quantum-ai-partners",
    build_id: "build-1",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

const FAQS = [
  {
    question: "How long does a CRM migration take?",
    answer:
      "Most migrations run in stages over several weeks, with a working change at each stage.",
  },
  {
    question: "Do you replace our CRM?",
    answer: "No. We restructure the records and workflows you already have before adding anything.",
  },
];

/** A QAP "/" route; `processText` lets a draft paraphrase an entity. */
function homeRoute(
  processText: string,
  faqs: StructuredContentRoute["faqs"] = FAQS,
): StructuredContentRoute {
  return {
    route_id: "home",
    path: "/",
    metadata: {
      title: "Quantum AI Partners",
      description: "CRM restructuring for growth-stage revenue teams.",
    },
    sections: [
      {
        section_id: "spec-component-1",
        heading: "Your CRM, restructured",
        blocks: [
          {
            kind: "paragraph",
            text:
              "Quantum AI Partners restructures the records your sellers already use, so pipeline " +
              "reports agree with what the team sees on every account.",
          },
        ],
      },
      {
        section_id: "spec-component-4",
        heading: "How the work runs",
        blocks: [{ kind: "paragraph", text: processText }],
      },
      { section_id: "spec-component-7", heading: "Common questions", blocks: [] },
    ],
    faqs,
    internal_links: [],
    schema_content_inputs: { faq: true },
  } as unknown as StructuredContentRoute;
}

const PARAPHRASED =
  "We audit your CRM, map every account into a relationship intelligence layer, and wire " +
  "RevOps reporting to it so forecasts come from one model.";
const LITERAL =
  "We audit your CRM, map every account into a relationship graph, and wire RevOps " +
  "reporting to it so forecasts come from one model.";

const thinFailure = (id: string) => `home: section "${id}" has no substantive content`;

describe("FAQ substance — rule (a): an FAQ section counts the route faqs it renders", () => {
  it("identifies the FAQ section by component class or faq slot", () => {
    const contract = homeContract();
    expect([...faqSectionIds(contract)]).toEqual(["spec-component-7"]);
    expect(isFaqContractSection(section("x", "accordion", "faq"))).toBe(true);
    expect(isFaqContractSection(section("y", "process", "process"))).toBe(false);
  });

  it("a QAP '/' FAQ section with blocks: [] and route faqs passes the substance check", () => {
    const { failures } = checkRouteGrounding(homeRoute(LITERAL), homeContract());
    expect(failures).not.toContain(thinFailure("spec-component-7"));
    expect(failures).toEqual([]);
  });

  it("keeps the 10-word floor: an FAQ section with no intro and no faqs still fails", () => {
    const { failures } = checkRouteGrounding(homeRoute(LITERAL, []), homeContract());
    expect(failures).toContain(thinFailure("spec-component-7"));
  });

  it("route faqs never pad a non-FAQ section", () => {
    const route = homeRoute(LITERAL);
    const hero = route.sections[0];
    if (hero) hero.blocks = [];
    const { failures } = checkRouteGrounding(route, homeContract());
    expect(failures).toContain(thinFailure("spec-component-1"));
  });
});

describe("required entities are literal — prompt and repair name the exact phrase", () => {
  it("the check stays literal: a paraphrase does not satisfy the entity", () => {
    const { failures } = checkRouteGrounding(homeRoute(PARAPHRASED), homeContract());
    expect(failures).toEqual(['home: required entity "Relationship graph" is not represented']);
  });

  it("entityPlacements names the exact phrase and the section that requires it", () => {
    expect(
      entityPlacements(
        ['home: required entity "Relationship graph" is not represented', "unrelated failure"],
        homeContract(),
      ),
    ).toEqual([
      {
        entity: "Relationship graph",
        section_ids: ["spec-component-4"],
        instruction:
          'Write the exact phrase "Relationship graph" (case-insensitive) in the prose of section "spec-component-4", in a sentence that uses it naturally. A synonym or variant does not count.',
      },
    ]);
  });
});

describe("QAP '/' end to end on a fake DeepSeek transport", () => {
  let ledgerDir: string;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "validator-alignment-spend-"));
  });
  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("an entity-missing first draft is repaired by the prompt's explicit phrase", async () => {
    const generationPrompts: Array<{ system: string; user: string }> = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      let reply: unknown;
      if (system.includes("sole owner of final website prose")) {
        generationPrompts.push({ system, user });
        const prompt = JSON.parse(user.split("\n\n---\n")[0] ?? "{}") as {
          repair_instructions?: {
            entity_placements: Array<{ entity: string; section_ids: string[] }>;
          };
        };
        const placements = prompt.repair_instructions?.entity_placements ?? [];
        const draft = homeRoute(PARAPHRASED);
        // A model that follows the repair's explicit instruction literally.
        for (const placement of placements) {
          const target = draft.sections.find((s) => s.section_id === placement.section_ids[0]);
          target?.blocks.push({
            kind: "paragraph",
            text: `The ${placement.entity} links each contact to the deals and accounts they influence.`,
          });
        }
        reply = draft;
      } else {
        reply = {
          seo_blueprint_passed: true,
          contract_passed: true,
          unsupported_claims: [],
          failed_requirements: [],
        };
      }
      const content = JSON.stringify(reply);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { completion_tokens: Math.ceil(content.length / 4) },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const llm = createDeepSeekBuildIntelligenceLlm({
      env: { DEEPSEEK_API_KEY: "test-key" },
      transport,
      ledgerDir,
    });

    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      {
        client_id: "quantum-ai-partners",
        build_id: "build-1",
        page_content_contract: contractArtifact(),
      },
      { llm },
    );

    // The first prompt lists the entities verbatim with the literal rule, and
    // names the FAQ section whose substance counts the route faqs.
    const first = JSON.parse(generationPrompts[0]?.user ?? "{}") as {
      required_entities_by_section: Array<{ section_id: string; entities: string[]; rule: string }>;
      faq_sections: string[];
    };
    expect(first.required_entities_by_section).toEqual([
      expect.objectContaining({ section_id: "spec-component-4", entities: ENTITIES }),
    ]);
    expect(first.required_entities_by_section[0]?.rule).toContain("exactly as listed");
    expect(first.faq_sections).toEqual(["spec-component-7"]);
    expect(generationPrompts[0]?.system).toContain("REQUIRED ENTITIES ARE LITERAL");

    // Exactly one repair, carrying the exact phrase and its section.
    expect(generationPrompts).toHaveLength(2);
    expect(generationPrompts[1]?.user).toContain('"entity": "Relationship graph"');
    expect(generationPrompts[1]?.user).toContain('"spec-component-4"');
    expect(evidence.repair_attempts).toBe(1);

    const sealed = artifact.payload.routes[0];
    const process = sealed?.sections.find((s) => s.section_id === "spec-component-4");
    expect(JSON.stringify(process).toLowerCase()).toContain("relationship graph");
    // The FAQ section sealed with blocks: [] — its substance is the route faqs.
    expect(sealed?.sections.find((s) => s.section_id === "spec-component-7")?.blocks).toEqual([]);
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
  });
});
