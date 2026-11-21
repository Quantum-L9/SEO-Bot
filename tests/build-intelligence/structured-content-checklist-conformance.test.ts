/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Conformance: the prompt's requirement checklist IS the validator's spec.
 *
 * Three QAP canaries in a row failed on a validator requirement the prompt did
 * not spell out (entity literal, FAQ substance, topic tokens). These tests make
 * that class of failure impossible to reintroduce silently:
 *
 * 1. A checklist-following fake model writes every QAP route from ONLY the
 *    rendered `requirement_checklist`, and each passes the real validator on
 *    the first attempt (no repair).
 * 2. Every failure message the deterministic validator can emit is classified,
 *    has a checklist instruction, and gets specific repair evidence. A new
 *    validator rule whose message is not classified fails the source scan.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  classifyRequirementFailure,
  REQUIREMENT_FAILURE_PATTERNS,
  type RequirementFailureKind,
  routeRequirementChecklist,
} from "../../src/build-intelligence/claim-grounding.js";
import {
  createStructuredContentPackageWithEvidence,
  renderRequirementChecklist,
  repairEvidence,
} from "../../src/build-intelligence/structured-content.js";
import { fakeDeepSeekLlm, isGenerationRequest, PASSING_VERDICT } from "./fixtures/fake-deepseek.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/* ── QAP 5-route contract (requirements shaped like the canary contracts) ── */

const dummyRef = {
  artifact_type: "website_build_blueprint" as const,
  artifact_id: "a".repeat(64),
  schema: "x",
  content_digest: "b".repeat(64),
};

interface SectionSpec {
  id: string;
  component: string;
  slot: string;
  topics?: string[];
  entities?: string[];
  questions?: string[];
  proofs?: string[];
}

function section(spec: SectionSpec): PageContentContractRoute["sections"][number] {
  return {
    section_id: spec.id,
    component_class: spec.component,
    objective: `explain ${spec.component}`,
    slots: [spec.slot],
    content_requirements: {
      requirement_ids: [`${spec.id}-r`],
      topics: spec.topics ?? [],
      entities: spec.entities ?? [],
      questions: spec.questions ?? [],
    },
    allowed_fact_ids: [],
    proof_requirements: spec.proofs ?? [],
    acceptance_tests: [],
  } as unknown as PageContentContractRoute["sections"][number];
}

const ROUTE_IDS = ["home", "crm-transformation", "revops", "how-it-works", "contact"];

function qapRoute(routeId: string, path: string, index: number): PageContentContractRoute {
  const next = ROUTE_IDS[(index + 1) % ROUTE_IDS.length] as string;
  return {
    route_id: routeId,
    path,
    purpose: `QAP ${routeId}`,
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: `crm consulting ${routeId}`,
      supporting_queries: [],
      topics: [],
      entities: [],
    },
    metadata_requirements: { title: ["name the service"], description: ["under 160 chars"] },
    business_facts: [
      {
        fact_id: "f1",
        key: "business_name",
        value: "Quantum AI Partners",
        verified: true,
        source_refs: ["spec"],
      },
      {
        fact_id: "f2",
        key: "delivery_model",
        value: "remote-first consulting",
        verified: true,
        source_refs: ["spec"],
      },
    ],
    sections: [
      section({
        id: "spec-component-1",
        component: "hero",
        slot: "primary_offer",
        topics: ["reproducible evidence"],
        entities: ["CRM"],
      }),
      section({
        id: "spec-component-4",
        component: "process",
        slot: "process",
        topics: ["pipeline forecasting"],
        entities: ["Relationship graph", "RevOps"],
        questions: ["How does an engagement start?"],
        proofs: ["documented methodology"],
      }),
      section({
        id: "spec-component-6",
        component: "contact",
        slot: "conversion",
        topics: ["contact availability"],
      }),
      section({ id: "spec-component-7", component: "faq", slot: "faq" }),
    ],
    internal_link_requirements: [{ target_route_id: next, purpose: "next step" }],
    forbidden_claims: ["Best in class", "Guaranteed results"],
    acceptance_tests: [],
  } as unknown as PageContentContractRoute;
}

const QAP_PATHS = ["/", "/crm-transformation", "/revops", "/how-it-works", "/contact"];

function qapContract(): PageContentContractArtifact {
  const payload = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: ROUTE_IDS.map((id, index) => qapRoute(id, QAP_PATHS[index] as string, index)),
  } as unknown as PageContentContractV1;
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "quantum-ai-partners",
    build_id: "build-1",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

/* ── A model that knows ONLY the rendered checklist ───────────────────────── */

/** The JSON-quoted values after the last ": " of an instruction. */
function quotedValues(instruction: string): string[] {
  const tail = instruction.slice(instruction.lastIndexOf(": ") + 2);
  return [...tail.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

/** Short filler, so units stay below the duplicate checker's 8-word floor. */
const FILLER = ["Clear practical guidance follows.", "Each step stays visible."];

function wordCount(texts: readonly string[]): number {
  return texts.join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * Writes a route from the rendered checklist alone. Every block is a short
 * sentence (< 8 words), one per requirement; it never reads the contract.
 */
function writeFromChecklist(userPrompt: string): StructuredContentRoute {
  const prompt = JSON.parse(userPrompt) as {
    contract_route: { route_id: string; path: string };
    requirement_checklist: ReturnType<typeof renderRequirementChecklist>;
  };
  const checklist = prompt.requirement_checklist;
  const routeInstructions = checklist.route_instructions;
  const linkLine = routeInstructions.find((line) => line.startsWith("Include an internal link"));
  const faqs: StructuredContentRoute["faqs"] = [];
  const sections = checklist.sections.map(({ section_id, instructions }) => {
    const texts: string[] = [];
    let minWords = 0;
    let isFaq = false;
    for (const line of instructions) {
      const words = /at least (\d+) words/.exec(line);
      if (words) minWords = Number(words[1]);
      if (line.startsWith("This FAQ section")) isFaq = true;
      if (line.includes("exact phrases")) {
        for (const phrase of quotedValues(line)) texts.push(`We use ${phrase} daily.`);
      }
      if (line.startsWith("Topic ") || line.startsWith("Address proof")) {
        texts.push(`${quotedValues(line).join(" ")} guide this work.`);
      }
      if (line.startsWith("Answer this question")) texts.push("It starts with one short call.");
    }
    if (isFaq) {
      while (wordCount(faqs.flatMap((faq) => [faq.question, faq.answer])) < minWords) {
        faqs.push({
          question: `Question ${faqs.length + 1} here?`,
          answer: "A short plain answer.",
        });
      }
      return { section_id, blocks: [] };
    }
    for (let index = 0; wordCount(texts) < minWords; index++) {
      texts.push(FILLER[index % FILLER.length] as string);
    }
    return {
      section_id,
      blocks: texts.map((text) => ({ kind: "paragraph" as const, text })),
    };
  });
  const route: StructuredContentRoute = {
    route_id: prompt.contract_route.route_id,
    path: prompt.contract_route.path,
    metadata: { title: "Quantum AI Partners", description: "CRM work for revenue teams." },
    sections,
    faqs,
    internal_links: (linkLine ? quotedValues(linkLine) : []).map((target) => ({
      target_route_id: target,
      anchor_text: "Next step",
    })),
    schema_content_inputs: { faq: faqs.length > 0 },
  } as StructuredContentRoute;
  // The fake must itself honour the "never write" instruction.
  const neverLine = routeInstructions.find((line) => line.startsWith("Never write any of these"));
  const text = JSON.stringify(route).toLowerCase();
  for (const banned of neverLine ? quotedValues(neverLine) : []) {
    if (text.includes(banned.toLowerCase())) throw new Error(`fake wrote banned "${banned}"`);
  }
  return route;
}

describe("a checklist-following model passes the real validator first time", () => {
  let ledgerDir: string;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "checklist-conformance-spend-"));
  });
  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("every QAP route seals on its first generation", async () => {
    const calls = { generation: 0, repair: 0 };
    const { llm } = fakeDeepSeekLlm((request) => {
      if (!isGenerationRequest(request)) return PASSING_VERDICT;
      calls.generation += 1;
      if (request.user.includes("repair_instructions")) calls.repair += 1;
      return writeFromChecklist(request.user.split("\n\n---\n")[0] ?? "{}");
    }, ledgerDir);
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      {
        client_id: "quantum-ai-partners",
        build_id: "build-1",
        page_content_contract: qapContract(),
      },
      { llm },
    );
    expect(calls).toEqual({ generation: ROUTE_IDS.length, repair: 0 });
    expect(evidence.repair_attempts).toBe(0);
    expect(artifact.payload.routes.map((route) => route.route_id)).toEqual(ROUTE_IDS);
    expect(artifact.payload.validation.failed_requirements).toEqual([]);
    const home = JSON.stringify(artifact.payload.routes[0]).toLowerCase();
    // The canary7 topics are covered literally.
    expect(home).toContain("reproducible");
    expect(home).toContain("availability");
  });
});

/* ── Every validator rule has a checklist instruction and a repair ─────────── */

const VALIDATOR_MODULES = [
  "src/build-intelligence/claim-grounding.ts",
  "src/build-intelligence/content-validator.ts",
  "src/build-intelligence/content-duplication.ts",
];

/**
 * Every message template a validator module emits, with `${...}` replaced by
 * "x": templates prefixed by a route id (claim-grounding, content-validator)
 * and templates opening with an UPPER_SNAKE finding code (content-duplication).
 */
function validatorMessageTemplates(): string[] {
  const templates: string[] = [];
  for (const file of VALIDATOR_MODULES) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const match of source.matchAll(
      /`((?:\$\{(?:route\.route_id|routeId)\}: |[A-Z][A-Z_]+: )[^`]*)`/g,
    )) {
      templates.push((match[1] as string).replace(/\$\{[^}]*\}/g, "x"));
    }
  }
  return templates;
}

/** The checklist instruction that teaches each requirement kind. */
const CHECKLIST_INSTRUCTION_FOR: Record<RequirementFailureKind, string> = {
  route_identity: "Produce exactly these section_ids",
  unexpected_section: "Produce exactly these section_ids",
  missing_section: "Produce exactly these section_ids",
  missing_metadata: "metadata.title and metadata.description must both be non-empty",
  missing_internal_link: "Include an internal link to each of these route ids",
  unsupported_quantified_claim: "must be one of",
  unsupported_magnitude_claim: '"decades of"',
  unsupported_credential_claim: '"warranty"',
  forbidden_claim: '"Best in class"',
  placeholder_content: '"lorem ipsum"',
  thin_section: "at least 10 words",
  missing_entity: "must contain these exact phrases",
  missing_topic: "must contain these exact words",
  duplicate_content: "Never repeat a paragraph",
  heading_restated: "never restate a heading as body copy",
  build_mechanics_in_copy: '"webhook"',
  presentation_limit: "Short rendered fields have word limits",
  unsupported_quote_attribution: "A quote block needs an attribution",
};

describe("validator ⇄ checklist conformance (property)", () => {
  const templates = validatorMessageTemplates();

  it("finds the validator's message templates", () => {
    // claim-grounding 8, content-validator 6, content-duplication 3.
    expect(templates.length).toBeGreaterThanOrEqual(17);
  });

  it.each(templates)("classifies every validator message: %s", (template) => {
    expect(classifyRequirementFailure(template)?.kind).toBeDefined();
  });

  it("every requirement kind the validator can emit has a checklist instruction", () => {
    const contract = qapRoute("home", "/", 0);
    // A verified number, so the quantified-claim instruction lists it.
    contract.business_facts.push({
      fact_id: "f3",
      key: "engagement_weeks",
      value: "6 weeks",
      verified: true,
      source_refs: ["spec"],
    } as (typeof contract.business_facts)[number]);
    const rendered = renderRequirementChecklist(routeRequirementChecklist(contract), ["webhook"]);
    const text = [
      ...rendered.route_instructions,
      ...rendered.sections.flatMap((entry) => entry.instructions),
    ].join("\n");
    const kinds = new Set(REQUIREMENT_FAILURE_PATTERNS.map((entry) => entry.kind));
    for (const kind of kinds) {
      expect(text, kind).toContain(CHECKLIST_INSTRUCTION_FOR[kind]);
    }
  });

  it("every validator message gets specific repair evidence, never the semantic pass-through", () => {
    const checklist = routeRequirementChecklist(qapRoute("home", "/", 0));
    for (const template of templates) {
      const [item] = repairEvidence([template], checklist);
      expect(item?.kind, template).not.toBe("semantic");
      expect(item?.instruction.length, template).toBeGreaterThan(0);
    }
  });

  it("topic repair evidence carries the exact missing tokens and the section", () => {
    const checklist = routeRequirementChecklist(qapRoute("home", "/", 0));
    const [item] = repairEvidence(
      ['home: required topic "contact availability" is not covered (missing: availability)'],
      checklist,
    );
    expect(item).toMatchObject({
      kind: "missing_topic",
      section_ids: ["spec-component-6"],
      must_write: ["availability"],
    });
  });

  it("an unclassified (new) validator message would fail the scan", () => {
    expect(
      classifyRequirementFailure("home: some new rule the checklist never heard of"),
    ).toBeUndefined();
  });
});
