/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import type {
  PageContentContractRoute,
  StructuredContentRoute,
  VerifiedBusinessFact,
} from "@quantum-l9/bot-interop";
import { describe, expect, it } from "vitest";
import { checkRouteGrounding } from "../../src/build-intelligence/claim-grounding.js";

function fact(fact_id: string, key: string, value: VerifiedBusinessFact["value"]) {
  return { fact_id, key, value, verified: true as const, source_refs: ["crm:1"] };
}

const FACTS: VerifiedBusinessFact[] = [
  fact("f1", "years_in_business", 12),
  fact("f2", "service_area", "Dallas, Texas"),
  fact("f3", "primary_service", "metal roof replacement"),
];

function contractRoute(
  overrides: Partial<PageContentContractRoute> = {},
): PageContentContractRoute {
  return {
    route_id: "home",
    path: "/",
    purpose: "primary landing page",
    search_context: {
      primary_intent: "hire a roofer",
      secondary_intents: [],
      primary_query: "metal roofing dallas",
      supporting_queries: [],
      topics: [],
      entities: [],
    },
    metadata_requirements: { title: [], description: [] },
    business_facts: FACTS,
    sections: [
      {
        section_id: "hero",
        component_class: "hero",
        objective: "state the offer",
        slots: ["primary_offer"],
        content_requirements: { requirement_ids: [], topics: [], entities: [], questions: [] },
        allowed_fact_ids: ["f1", "f2", "f3"],
        proof_requirements: [],
        acceptance_tests: [],
      },
    ],
    internal_link_requirements: [],
    forbidden_claims: [],
    acceptance_tests: [],
    ...overrides,
  };
}

function route(paragraph: string, overrides: Partial<StructuredContentRoute> = {}) {
  return {
    route_id: "home",
    path: "/",
    metadata: { title: "Metal Roof Replacement in Dallas", description: "Serving Dallas, Texas." },
    sections: [
      {
        section_id: "hero",
        heading: "Metal roof replacement",
        blocks: [{ kind: "paragraph" as const, text: paragraph }],
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
    ...overrides,
  } satisfies StructuredContentRoute;
}

const GROUNDED =
  "We handle metal roof replacement across Dallas, Texas, and have been doing it for 12 years. " +
  "Every project is scoped on site so you know what the work involves before we begin.";

describe("claim grounding — the decades-of-experience regression", () => {
  it("passes prose whose numbers come from the verified facts", () => {
    const verdict = checkRouteGrounding(route(GROUNDED), contractRoute());
    expect(verdict.unsupportedClaims).toEqual([]);
    expect(verdict.failures).toEqual([]);
  });

  it("flags 'decades of experience' when the verified fact says 12 years", () => {
    const verdict = checkRouteGrounding(
      route(
        "With decades of experience in metal roof replacement, our team serves Dallas, Texas homeowners every day of the week.",
      ),
      contractRoute(),
    );
    expect(verdict.unsupportedClaims.join(" ")).toMatch(/decades of experience/);
  });

  it("flags a year count that no verified fact asserts", () => {
    const verdict = checkRouteGrounding(
      route(
        "For over 35 years we have delivered metal roof replacement to Dallas, Texas families across the region.",
      ),
      contractRoute(),
    );
    expect(verdict.unsupportedClaims.join(" ")).toMatch(/35/);
  });

  it("accepts a year count that IS a verified fact", () => {
    const verdict = checkRouteGrounding(
      route(
        "For 12 years we have delivered metal roof replacement to Dallas, Texas families across the region.",
      ),
      contractRoute(),
    );
    expect(verdict.unsupportedClaims).toEqual([]);
  });
});

describe("claim grounding — unsupported factual claim categories", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "project volume",
      "We have completed 4,000 roofs for Dallas, Texas homeowners over our 12 years in business.",
      /4000|completed work volume/,
    ],
    [
      "team size",
      "Our 40 technicians deliver metal roof replacement across Dallas, Texas throughout our 12 years.",
      /team size|40/,
    ],
    [
      "price",
      "Metal roof replacement in Dallas, Texas starts at $8,500 and our 12 years of work back it.",
      /price|8500/,
    ],
    [
      "warranty",
      "Our metal roof replacement in Dallas, Texas carries a lifetime warranty after 12 years of practice.",
      /warranty/,
    ],
    [
      "licensing",
      "We are a licensed and insured metal roof replacement contractor in Dallas, Texas with 12 years behind us.",
      /licensed|insured/,
    ],
    [
      "availability",
      "Emergency service is available 24/7 for metal roof replacement in Dallas, Texas after 12 years serving it.",
      /24\/7|emergency service/,
    ],
    [
      "founding year",
      "Since 1978 we have provided metal roof replacement in Dallas, Texas, now 12 years under this ownership.",
      /founding year|1978/,
    ],
  ];

  for (const [name, prose, pattern] of cases) {
    it(`flags an unsupported ${name} claim`, () => {
      const verdict = checkRouteGrounding(route(prose), contractRoute());
      expect(verdict.unsupportedClaims.join(" ")).toMatch(pattern);
    });
  }

  it("accepts a credential claim that the verified facts do assert", () => {
    const withLicense = [...FACTS, fact("f4", "licensing", "licensed and insured in Texas")];
    const verdict = checkRouteGrounding(
      route(
        "We are a licensed and insured metal roof replacement contractor in Dallas, Texas with 12 years behind us.",
      ),
      contractRoute({ business_facts: withLicense }),
    );
    expect(verdict.unsupportedClaims).toEqual([]);
  });
});

describe("claim grounding — contract failures", () => {
  it("flags an explicitly forbidden claim", () => {
    const verdict = checkRouteGrounding(
      route(`${GROUNDED} We are the number one roofer in Texas.`),
      contractRoute({ forbidden_claims: ["number one roofer"] }),
    );
    expect(verdict.failures.join(" ")).toMatch(/forbidden claim "number one roofer"/);
  });

  it("flags placeholder content", () => {
    const verdict = checkRouteGrounding(
      route("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor."),
      contractRoute(),
    );
    expect(verdict.failures.join(" ")).toMatch(/placeholder content/);
  });

  it("flags a section with no substantive content", () => {
    const verdict = checkRouteGrounding(route("Roofing."), contractRoute());
    expect(verdict.failures.join(" ")).toMatch(/no substantive content/);
  });

  it("flags a required entity that is not represented", () => {
    const contract = contractRoute();
    contract.sections[0]!.content_requirements.entities = ["Owens Corning"];
    const verdict = checkRouteGrounding(route(GROUNDED), contract);
    expect(verdict.failures.join(" ")).toMatch(/required entity "Owens Corning"/);
  });

  it("flags a required topic whose significant tokens are absent", () => {
    const contract = contractRoute();
    contract.sections[0]!.content_requirements.topics = ["standing seam installation"];
    const verdict = checkRouteGrounding(route(GROUNDED), contract);
    expect(verdict.failures.join(" ")).toMatch(/required topic "standing seam installation"/);
  });

  it("accepts a required topic covered with different phrasing", () => {
    const contract = contractRoute();
    contract.sections[0]!.content_requirements.topics = ["metal replacement roofing"];
    const verdict = checkRouteGrounding(route(GROUNDED), contract);
    expect(verdict.failures).toEqual([]);
  });
});
