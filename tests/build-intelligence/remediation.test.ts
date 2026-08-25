import { describe, it, expect } from "vitest";
import { applyDeterministicRemediation } from "../../src/build-intelligence/structured-content.js";
import type { PageContentContractRoute, StructuredContentRoute } from "@quantum-l9/bot-interop";

function makeRoute(surface: Partial<Record<string, string>>, blocks: Array<Record<string, unknown>>, ctaAction = "quote"): StructuredContentRoute {
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
        cta: surface.cta ? { label: surface.cta, action: ctaAction } : undefined,
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

  it("removes a claim whose words straddle adjacent text surfaces (golden run #40)", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported credential/guarantee claim "free estimate" — no verified fact asserts it'],
    };
    const route = applyDeterministicRemediation(
      makeRoute(
        { cta: "Get Your Free" },
        [{ kind: "paragraph", text: "substantive content here for the floor" }],
        "Estimate",
      ),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("free estimate");
    expect(joined).not.toContain("estimate");
  });

  it("removes a claim split across a line break inside one field", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported credential/guarantee claim "free estimate" — no verified fact asserts it'],
    };
    const route = applyDeterministicRemediation(
      makeRoute({}, [{ kind: "paragraph", text: "Call for a free\nestimate — substantive content here" }]),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("free estimate");
  });

  it("removes ungrounded lifespan clauses entirely (golden run #46)", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported years of experience claim "30 years" — no verified fact asserts 30'],
    };
    const route = applyDeterministicRemediation(
      makeRoute(
        {},
        [{ kind: "paragraph", text: "EPDM rubber membranes can last 30 years with proper maintenance — substantive content here" }],
      ),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("30 years");
    expect(joined).not.toContain("last years");
    expect(joined).not.toContain("lifespan");
  });

  it("keeps grounded lifespan-adjacent facts (warranty years)", () => {
    const route = applyDeterministicRemediation(
      makeRoute({}, [{ kind: "paragraph", text: "Our 5-year workmanship warranty covers workmanship for 5 years — substantive content here" }]),
      verdict,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    // The warranty fact asserts 5-year terms — both mentions stay.
    expect(joined).toContain("5-year workmanship warranty");
    expect(joined).toContain("for 5 years");
  });

  it("removes age-comparison clauses whole (golden run #50)", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported years of experience claim "20 years" — no verified fact asserts 20'],
    };
    const route = applyDeterministicRemediation(
      makeRoute(
        {},
        [{ kind: "paragraph", text: "Roof age over 20 years typically favors replacement — substantive content here" }],
      ),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("20 years");
    expect(joined).not.toContain("over years");
  });

  it("removes forbidden claims from every surface (golden run #55)", () => {
    const withForbidden = { ...contract, forbidden_claims: ["Best in Charlotte"] };
    const route = applyDeterministicRemediation(
      makeRoute(
        {},
        [{ kind: "paragraph", text: "We are the Best in Charlotte for metal roofing — substantive content here" }],
      ),
      verdict,
      withForbidden,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("best in charlotte");
  });

  it("strips the dangling number when a straddling phrase is removed (golden run #59)", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported magnitude claim "years of experience" — no verified fact asserts it'],
    };
    // "6 years of" ends the heading; "experience serving..." starts the
    // paragraph. The straddle pass must remove the phrase AND the dangling
    // quantifying number, never leaving "6 serving".
    const route = applyDeterministicRemediation(
      makeRoute(
        { heading: "Trusted local service with 6 years of" },
        [{ kind: "paragraph", text: "experience serving Charlotte's unique weather conditions — substantive content" }],
      ),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("6 serving");
    expect(joined).not.toContain("years of experience");
  });

  it("removes derived forms of a banned token (substring authority, golden run #41)", () => {
    const split = {
      ...verdict,
      unsupported_claims: ['/: unsupported credential/guarantee claim "certification" — no verified fact asserts it'],
    };
    const route = applyDeterministicRemediation(
      makeRoute(
        {},
        [{ kind: "paragraph", text: "Our recertification program and GAF certifications matter — substantive content here" }],
      ),
      split,
      contract,
    );
    const joined = JSON.stringify(route).toLowerCase().replace(/\s+/g, " ");
    expect(joined).not.toContain("certification");
  });
});
