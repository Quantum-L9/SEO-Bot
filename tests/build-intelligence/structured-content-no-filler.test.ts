/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Regression: the deterministic remediation must never manufacture customer
 * copy. QAP canary qap-canary5-20261121T031827Z rendered
 * "Regarding relationship graph: Quantum AI Partners provides
 * ai_revops_crm_transformation services across US. Learn more at …" on the
 * home page — fact-template filler appended to pass coverage checks, carrying a
 * raw fact slug. Missed topics and thin sections now go through the one bounded
 * LLM repair, and fail typed if still unmet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PageContentContractArtifact,
  type PageContentContractV1,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekBuildIntelligenceLlm } from "../../src/build-intelligence/deepseek-llm.js";
import {
  applyDeterministicRemediation,
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackageWithEvidence,
  isIdentifierLikeFactValue,
} from "../../src/build-intelligence/structured-content.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SLUG = "ai_revops_crm_transformation";
const dummyRef = {
  artifact_type: "website_build_blueprint" as const,
  artifact_id: "a".repeat(64),
  schema: "x",
  content_digest: "b".repeat(64),
};

function contractPayload(): PageContentContractV1 {
  return {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: [
      {
        route_id: "home",
        path: "/",
        purpose: "primary landing",
        search_context: {
          primary_intent: "hire",
          secondary_intents: [],
          primary_query: "crm transformation",
          supporting_queries: [],
          topics: ["relationship graph"],
          entities: [],
        },
        metadata_requirements: { title: [], description: [] },
        business_facts: [
          {
            fact_id: "f1",
            key: "business_name",
            value: "Quantum AI Partners",
            verified: true,
            source_refs: ["crm:1"],
          },
          { fact_id: "f2", key: "vertical", value: SLUG, verified: true, source_refs: ["crm:1"] },
          {
            fact_id: "f3",
            key: "site_url",
            value: "https://www.quantumaipartners.com",
            verified: true,
            source_refs: ["crm:1"],
          },
        ],
        sections: [
          {
            section_id: "hero",
            component_class: "hero",
            objective: "convey primary offer",
            slots: ["primary_offer"],
            content_requirements: {
              requirement_ids: ["r1"],
              topics: ["relationship graph"],
              entities: [],
              questions: [],
            },
            allowed_fact_ids: [],
            proof_requirements: [],
            acceptance_tests: [],
          },
          {
            section_id: "faq-intro",
            component_class: "faq",
            objective: "introduce the FAQ",
            slots: ["faq"],
            content_requirements: { requirement_ids: [], topics: [], entities: [], questions: [] },
            allowed_fact_ids: [],
            proof_requirements: [],
            acceptance_tests: [],
          },
        ],
        internal_link_requirements: [],
        forbidden_claims: [],
        acceptance_tests: [],
      },
    ],
  } as unknown as PageContentContractV1;
}

function contract(): PageContentContractArtifact {
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "quantum-ai-partners",
    build_id: "build-1",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload: contractPayload(),
  });
}

/** Misses the "relationship graph" topic and leaves the FAQ intro thin. */
function deficientRoute(): StructuredContentRoute {
  return {
    route_id: "home",
    path: "/",
    metadata: { title: "CRM transformation", description: "RevOps and CRM work for growth teams." },
    sections: [
      {
        section_id: "hero",
        heading: "CRM transformation",
        blocks: [
          {
            kind: "paragraph",
            text:
              "Quantum AI Partners rebuilds revenue operations around a single, clean CRM so " +
              "sales, marketing and success teams work from the same customer record every day.",
          },
        ],
      },
      {
        section_id: "faq-intro",
        heading: "Questions",
        blocks: [{ kind: "paragraph", text: "FAQ." }],
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  } as unknown as StructuredContentRoute;
}

/** What a compliant repair returns: the topic covered, no thin section. */
function repairedRoute(): StructuredContentRoute {
  const route = deficientRoute();
  route.sections[0]?.blocks.push({
    kind: "paragraph",
    text:
      "We map every account, contact and opportunity into one relationship graph, so the team " +
      "can see who influences a deal before the next call.",
  });
  const faqIntro = route.sections[1];
  if (faqIntro) {
    faqIntro.blocks = [
      {
        kind: "paragraph",
        text:
          "These answers cover how an engagement starts, what we need from your team, and how " +
          "the CRM migration is sequenced week by week.",
      },
    ];
  }
  return route;
}

function homeContractRoute(): PageContentContractV1["routes"][number] {
  const route = contractPayload().routes[0];
  if (!route) throw new Error("fixture has no route");
  return route;
}

function routeText(route: unknown): string {
  return JSON.stringify(route);
}

describe("deterministic remediation only removes text", () => {
  it("appends nothing for a missed topic or a thin section", () => {
    const route = deficientRoute();
    const before = route.sections.map((section) => section.blocks.length);
    const remediated = applyDeterministicRemediation(
      route,
      {
        route_id: "home",
        contract_passed: false,
        seo_blueprint_passed: true,
        unsupported_claims: [],
        failed_requirements: [
          'home: required topic "relationship graph" is not covered (missing: relationship graph)',
          'home: section "faq-intro" has no substantive content',
        ],
      },
      homeContractRoute(),
    );
    expect(remediated.sections.map((section) => section.blocks.length)).toEqual(before);
    expect(routeText(remediated)).not.toContain("Regarding ");
    expect(routeText(remediated)).not.toContain("Learn more at");
  });

  it("omits an identifier-shaped fact value the model copied into prose", () => {
    const route = deficientRoute();
    const hero = route.sections[0];
    if (hero) {
      hero.blocks = [
        {
          kind: "paragraph",
          text: `Quantum AI Partners provides ${SLUG} services for growth teams across the US.`,
        },
      ];
    }
    route.faqs = [{ question: `What is ${SLUG}?`, answer: `${SLUG} is our practice.` }];
    const remediated = applyDeterministicRemediation(
      route,
      {
        route_id: "home",
        contract_passed: false,
        seo_blueprint_passed: true,
        unsupported_claims: [],
        failed_requirements: [],
      },
      homeContractRoute(),
    );
    const text = routeText(remediated);
    expect(text).not.toContain(SLUG);
    expect(text).toContain("Quantum AI Partners provides services for growth teams across the US.");
    const prose = [
      ...remediated.sections.flatMap((section) =>
        section.blocks.flatMap((block) => ("text" in block ? [block.text] : block.items)),
      ),
      ...remediated.faqs.flatMap((faq) => [faq.question, faq.answer]),
    ].join(" ");
    expect(prose).not.toMatch(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/);
  });

  it("classifies identifier-shaped values", () => {
    expect(isIdentifierLikeFactValue(SLUG)).toBe(true);
    expect(isIdentifierLikeFactValue("crm_v2")).toBe(true);
    expect(isIdentifierLikeFactValue("Quantum AI Partners")).toBe(false);
    expect(isIdentifierLikeFactValue("https://www.quantumaipartners.com")).toBe(false);
    expect(isIdentifierLikeFactValue("snake_case words with spaces")).toBe(false);
    expect(isIdentifierLikeFactValue("")).toBe(false);
  });
});

describe("missed topic + thin section — LLM repair or typed failure (fake DeepSeek transport)", () => {
  let ledgerDir: string;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "no-filler-spend-"));
  });
  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  function transportFor(repair: () => StructuredContentRoute) {
    const calls = { generation: 0, repair: 0, validation: 0 };
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      let reply: unknown;
      if (system.includes("sole owner of final website prose")) {
        calls.generation += 1;
        if (user.includes("repair_instructions")) {
          calls.repair += 1;
          reply = repair();
        } else {
          reply = deficientRoute();
        }
      } else {
        calls.validation += 1;
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
    return { llm, calls };
  }

  it("the bounded LLM repair receives the evidence and its prose ships — never filler", async () => {
    const { llm, calls } = transportFor(repairedRoute);
    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "quantum-ai-partners", build_id: "build-1", page_content_contract: contract() },
      { llm },
    );
    expect(calls.generation).toBe(2);
    expect(calls.repair).toBe(1);
    expect(evidence.repair_attempts).toBe(1);
    const text = routeText(artifact.payload.routes);
    expect(text).toContain("relationship graph");
    expect(text).not.toContain("Regarding ");
    expect(text).not.toContain(SLUG);
  });

  it("a repair that leaves the topic and thin section unmet fails typed instead of shipping filler", async () => {
    const { llm, calls } = transportFor(deficientRoute);
    const error = await createStructuredContentPackageWithEvidence(
      { client_id: "quantum-ai-partners", build_id: "build-1", page_content_contract: contract() },
      { llm },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentRequirementUnsatisfiedError);
    const failed = (error as ContentRequirementUnsatisfiedError).failedRequirements.join(" ");
    expect(failed).toContain("relationship graph");
    expect(failed).toContain("faq-intro");
    expect(calls.generation).toBe(2);
    expect(calls.repair).toBe(1);
  });
});
