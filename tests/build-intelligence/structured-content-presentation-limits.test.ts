/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Presentation limits from the requirement checklist (QAP canary9,
 * qap-canary9-20261121T063103Z). Website-Bot's blocking site-quality stage
 * failed on:
 * - nav-label-run-on: an internal-link anchor of 6 words (limit 5);
 * - run-on-text: an uppercase-rendered eyebrow of 6+ words.
 * The limits live in the checklist, so the validator, prompt and repair share
 * them; a violation is repaired with the exact field and word count, and still
 * fails typed after the one repair — never truncated silently.
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
  PRESENTATION_LIMITS,
  presentationWordCount,
} from "../../src/build-intelligence/claim-grounding.js";
import {
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackageWithEvidence,
} from "../../src/build-intelligence/structured-content.js";
import { fakeDeepSeekLlm, isGenerationRequest, PASSING_VERDICT } from "./fixtures/fake-deepseek.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const LONG_ANCHOR = "AI RevOps activation and close deals"; // 6 words
const LONG_EYEBROW = "A clear four-step journey from dormant records to actionable deals"; // 10 words

const dummyRef = {
  artifact_type: "website_build_blueprint" as const,
  artifact_id: "a".repeat(64),
  schema: "x",
  content_digest: "b".repeat(64),
};

/** QAP /how-it-works shape: a hero with an eyebrow and a link to /revops. */
function howItWorksContract(): PageContentContractRoute {
  return {
    route_id: "how-it-works",
    path: "/how-it-works",
    purpose: "process",
    search_context: {
      primary_intent: "learn",
      secondary_intents: [],
      primary_query: "crm transformation process",
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
      {
        section_id: "spec-component-1",
        component_class: "hero",
        objective: "frame the process",
        slots: ["primary_offer"],
        content_requirements: { requirement_ids: ["r1"], topics: [], entities: [], questions: [] },
        allowed_fact_ids: [],
        proof_requirements: [],
        acceptance_tests: [],
      },
    ],
    internal_link_requirements: [{ target_route_id: "revops", purpose: "related service" }],
    forbidden_claims: [],
    acceptance_tests: [],
  } as unknown as PageContentContractRoute;
}

function contract(): PageContentContractArtifact {
  const payload = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: [howItWorksContract()],
  } as unknown as PageContentContractV1;
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "quantum-ai-partners",
    build_id: "build-1",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

function route(anchor: string, eyebrow: string, ctaLabel = "Book a call"): StructuredContentRoute {
  return {
    route_id: "how-it-works",
    path: "/how-it-works",
    metadata: { title: "How it works", description: "Four stages from audit to handover." },
    sections: [
      {
        section_id: "spec-component-1",
        eyebrow,
        heading: "From records to revenue",
        blocks: [
          {
            kind: "paragraph",
            text:
              "We audit the CRM first, then enrich records, activate workflows and hand over " +
              "a documented playbook your team can run.",
          },
        ],
        cta: { label: ctaLabel, action: "contact" },
      },
    ],
    faqs: [],
    internal_links: [{ target_route_id: "revops", anchor_text: anchor }],
    schema_content_inputs: {},
  } as unknown as StructuredContentRoute;
}

describe("presentation limits — validator rule from the checklist", () => {
  it("mirrors the Website-Bot checker limits", () => {
    expect(PRESENTATION_LIMITS).toEqual({ anchor_text: 5, eyebrow: 5, cta_label: 8 });
    expect(presentationWordCount(LONG_ANCHOR)).toBe(6);
    expect(presentationWordCount(LONG_EYEBROW)).toBe(10);
  });

  it("names the exact field and word count for each violation", () => {
    const { failures } = checkRouteGrounding(
      route(LONG_ANCHOR, LONG_EYEBROW, "Book a free thirty minute discovery call with us today"),
      howItWorksContract(),
    );
    expect(failures).toEqual([
      "how-it-works: internal_links[0].anchor_text has 6 words (limit 5)",
      "how-it-works: sections.spec-component-1.eyebrow has 10 words (limit 5)",
      "how-it-works: sections.spec-component-1.cta.label has 10 words (limit 8)",
    ]);
  });

  it("accepts fields at the limit", () => {
    const { failures } = checkRouteGrounding(
      route(
        "Activate RevOps and close deals",
        "Four steps to actionable deals",
        "Book a short call",
      ),
      howItWorksContract(),
    );
    expect(failures).toEqual([]);
  });
});

describe("presentation limits — repaired by exact evidence, or typed failure (fake transport)", () => {
  let ledgerDir: string;
  beforeEach(() => {
    ledgerDir = mkdtempSync(join(tmpdir(), "presentation-limits-spend-"));
  });
  afterEach(() => {
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  interface Evidence {
    kind: string;
    instruction: string;
    section_ids: string[];
  }

  function run(followRepair: boolean) {
    const repairs: Evidence[][] = [];
    const { llm } = fakeDeepSeekLlm((request) => {
      if (!isGenerationRequest(request)) return PASSING_VERDICT;
      const prompt = JSON.parse(request.user.split("\n\n---\n")[0] ?? "{}") as {
        repair_instructions?: { repair_evidence: Evidence[] };
      };
      const evidence = prompt.repair_instructions?.repair_evidence;
      if (!evidence) return route(LONG_ANCHOR, LONG_EYEBROW);
      repairs.push(evidence);
      if (!followRepair) return route(LONG_ANCHOR, LONG_EYEBROW);
      // A model that rewrites each named field within its stated limit.
      const asked = evidence.map((item) => item.instruction).join("\n");
      return route(
        asked.includes("internal_links[0].anchor_text") ? "RevOps activation" : LONG_ANCHOR,
        asked.includes("sections.spec-component-1.eyebrow") ? "Four steps to deals" : LONG_EYEBROW,
      );
    }, ledgerDir);
    return {
      repairs,
      produce: () =>
        createStructuredContentPackageWithEvidence(
          {
            client_id: "quantum-ai-partners",
            build_id: "build-1",
            page_content_contract: contract(),
          },
          { llm },
        ),
    };
  }

  it("a 6-word anchor and a 10-word eyebrow are repaired to within the limits", async () => {
    const { repairs, produce } = run(true);
    const { artifact, evidence } = await produce();
    expect(evidence.repair_attempts).toBe(1);
    expect(repairs).toHaveLength(1);
    const limits = (repairs[0] ?? []).filter((item) => item.kind === "presentation_limit");
    expect(limits.map((item) => item.instruction)).toEqual([
      "Shorten internal_links[0].anchor_text from 6 words to at most 5 words. Rewrite it as a complete short phrase with the same meaning; do not cut it off mid-phrase.",
      "Shorten sections.spec-component-1.eyebrow from 10 words to at most 5 words. Rewrite it as a complete short phrase with the same meaning; do not cut it off mid-phrase.",
    ]);
    expect(limits[1]?.section_ids).toEqual(["spec-component-1"]);
    const sealed = artifact.payload.routes[0];
    expect(sealed?.internal_links[0]?.anchor_text).toBe("RevOps activation");
    expect(sealed?.sections[0]?.eyebrow).toBe("Four steps to deals");
  });

  it("still fails typed after the one repair — the field is never truncated", async () => {
    const { repairs, produce } = run(false);
    const error = await produce().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect((error as ContentRequirementUnsatisfiedError).failedRequirements).toEqual(
      expect.arrayContaining([
        "how-it-works: internal_links[0].anchor_text has 6 words (limit 5)",
        "how-it-works: sections.spec-component-1.eyebrow has 10 words (limit 5)",
      ]),
    );
    expect(repairs).toHaveLength(1);
  });
});
