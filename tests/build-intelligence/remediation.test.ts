import { describe, it, expect } from "vitest";
import { applyDeterministicRemediation } from "../../src/build-intelligence/structured-content.js";
import type { PageContentContractRoute, StructuredContentRoute } from "@quantum-l9/bot-interop";

function makeRoute(surface: Partial<Record<string, string>>, blocks: Array<Record<string, unknown>>): StructuredContentRoute {
  return {
    route_id: "/",
    path: "/",
    metadata: { title: surface.title ?? "Home", description: surface.description ?? "desc" },
    sections: [
      {
        section_id: "overview",
        eyebrow: surface.eyebrow,
        heading: surface.heading ?? "Overview",
        subheading: surface.subheading,
        cta: surface.cta ? { label: surface.cta, action: "quote" } : undefined,
        blocks,
      },
    ],
    faqs: surface.faq ? [{ question: surface.faq, answer: surface.faq }] : [],
    internal_links: surface.link ? [{ target_route_id: "/about", anchor_text: surface.link }] : [],
    schema_content_inputs: {},
  } as unknown as StructuredContentRoute;
}

const contract = {
  route_id: "/",
  path: "/",
  business_facts: [
    { fact_id: "f1", key: "business_name", value: "Safe Haven Roofing & Renovations", verified: true, source_refs: ["x"] },
    { fact_id: "f2", key: "locality", value: "Charlotte, NC", verified: true, source_refs: ["x"] },
    { fact_id: "f3", key: "hours", value: "24/7 emergency service available", verified: true, source_refs: ["x"] },
    { fact_id: "f4", key: "years_local_experience", value: 6, verified: true, source_refs: ["x"] },
    { fact_id: "f5", key: "fully_insured", value: "fully insured", verified: true, source_refs: ["x"] },
    { fact_id: "f6", key: "free_inspection", value: "free inspection", verified: true, source_refs: ["x"] },
    { fact_id: "f7", key: "workmanship_warranty_years", value: "5-year workmanship warranty; warranties cover workmanship for 5 years", verified: true, source_refs: ["x"] },
  ],
  sections: [{ section_id: "overview", content_requirements: { topics: [], entities: [], questions: [], requirement_ids: [] }, allowed_fact_ids: [], proof_requirements: [] }],
  internal_link_requirements: [],
  forbidden_claims: [],
  acceptance_tests: [],
} as unknown as PageContentContractRoute;

const verdict = {
  route_id: "/",
  contract_passed: false,
  seo_blueprint_passed: true,
  failed_requirements: [],
  unsupported_claims: ['/: unsupported credential/guarantee claim "certification" — no verified fact asserts it'],
};

function textOf(route: StructuredContentRoute): string {
  return JSON.stringify(route).toLowerCase();
}

describe("deterministic remediation scrub surface", () => {
  it("removes certification from every text surface", () => {
    for (const [label, surface, blocks] of [
      ["paragraph", {}, [{ kind: "paragraph", text: "We hold a certification for roofing." }]],
      ["quote", {}, [{ kind: "quote", text: "certification matters", attribution: "Our certification team" }]],
      ["bullets", {}, [{ kind: "bullets", items: ["certification included"] }]],
      ["eyebrow", { eyebrow: "certification" }, [{ kind: "paragraph", text: "substantive content here for the floor" }]],
      ["cta", { cta: "Get certification" }, [{ kind: "paragraph", text: "substantive content here for the floor" }]],
      ["faq", { faq: "Is there a certification?" }, [{ kind: "paragraph", text: "substantive content here for the floor" }]],
      ["link", { link: "certification details" }, [{ kind: "paragraph", text: "substantive content here for the floor" }]],
      ["metadata", { title: "Certification Experts", description: "desc" }, [{ kind: "paragraph", text: "substantive content here for the floor" }]],
    ] as Array<[string, Record<string, string>, Array<Record<string, unknown>>]>) {
      const route = applyDeterministicRemediation(makeRoute(surface, blocks), verdict, contract);
      expect(textOf(route)).not.toContain("certification");
    }
  });
});
