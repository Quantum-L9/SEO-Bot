/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * Regression tests for the QAP canary (qap-canary5) site-quality findings:
 * an H1 restated as a self-attributed quote, process-step paragraphs repeated
 * across routes and within a route, and /contact copy that described the
 * build. Fake transports only.
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
import {
  contentUnits,
  DUPLICATE_SIMILARITY,
  findContentFindings,
  shingleSimilarity,
} from "../../src/build-intelligence/content-duplication.js";
import type { ContentValidationVerdict } from "../../src/build-intelligence/schema-guards.js";
import {
  ContentRequirementUnsatisfiedError,
  createStructuredContentPackageWithEvidence,
} from "../../src/build-intelligence/structured-content.js";
import type { LlmService } from "../../src/services/llm.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/* ── Canary text ─────────────────────────────────────────────────────────────── */

const H1 = "Your CRM has the data. We bring it to life.";
const PROCESS_STEP =
  "Connect: bring existing CRM and relevant enterprise records into a coherent analysis " +
  "so revenue operations can see every account in one place.";
/** One word changed: a near-duplicate the checker flags (Jaccard ≥ 0.6, below 1). */
const PROCESS_STEP_NEAR =
  "Connect: bring existing CRM and relevant enterprise records into a coherent analysis " +
  "so revenue operations can review every account in one place.";
const CONTACT_LEAK =
  "Requests go to a verified HTTPS lead endpoint, without a live booking form or invented " +
  "contact details.";

/* ── Contract ───────────────────────────────────────────────────────────────── */

const dummyRef: ArtifactRef = {
  artifact_type: "website_build_blueprint",
  artifact_id: "x",
  payload_digest: "y",
};

const FACTS = [
  {
    fact_id: "f-name",
    key: "company_name",
    value: "Quantum AI Partners",
    verified: true as const,
    source_refs: ["spec"],
  },
  {
    fact_id: "f-model",
    key: "delivery_model",
    value: "remote-first consulting",
    verified: true as const,
    source_refs: ["spec"],
  },
];

const QAP_ROUTES = [
  { route_id: "home", path: "/" },
  { route_id: "crm-transformation", path: "/crm-transformation" },
  { route_id: "revops", path: "/revops" },
  { route_id: "how-it-works", path: "/how-it-works" },
  { route_id: "contact", path: "/contact" },
];

function contractRoute(routeId: string, path: string): PageContentContractRoute {
  return {
    route_id: routeId,
    path,
    purpose: `QAP ${routeId}`,
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: `crm consulting ${routeId}`,
      supporting_queries: [],
      topics: ["crm transformation"],
      entities: ["revenue operations"],
    },
    metadata_requirements: { title: ["name the service"], description: ["<160 chars"] },
    business_facts: FACTS,
    sections: ["hero", "process"].map((sectionId) => ({
      section_id: sectionId,
      component_class: sectionId,
      objective: `explain ${sectionId}`,
      slots: ["service_overview" as const],
      content_requirements: {
        requirement_ids: [`${routeId}-${sectionId}`],
        topics: ["crm transformation"],
        entities: ["revenue operations"],
        questions: [],
      },
      allowed_fact_ids: ["f-name", "f-model"],
      proof_requirements: [],
      acceptance_tests: [],
    })),
    internal_link_requirements: [],
    forbidden_claims: [],
    acceptance_tests: [],
  };
}

function contract(routes = QAP_ROUTES): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: routes.map((route) => contractRoute(route.route_id, route.path)),
  };
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "qap",
    build_id: "qap-build",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

/* ── Fake model ──────────────────────────────────────────────────────────────── */

/** Hand-written, grounded copy per route, so only the injected defects repeat. */
const INTRO: Readonly<Record<string, string>> = {
  home: "Quantum AI Partners turns a stalled CRM into revenue operations your sales leaders trust, through crm transformation delivered as remote-first consulting.",
  "crm-transformation":
    "A crm transformation starts by mapping how records, owners and stages drift apart, then rebuilding them so revenue operations reporting finally agrees.",
  revops:
    "Revenue operations activation means routing, scoring and forecasting run from one model, which is where our crm transformation work pays back first.",
  "how-it-works":
    "Every crm transformation engagement follows four remote-first stages, and each stage ends with a working change your revenue operations team can inspect before the next one begins.",
  contact:
    "Tell us which pipeline reports you distrust today; a short call is enough to scope crm transformation and the revenue operations work around it.",
};
const PROCESS: Readonly<Record<string, string>> = {
  home: "We begin with a diagnostic of your current CRM, so the crm transformation plan targets the revenue operations gaps that cost deals now.",
  "crm-transformation":
    "Field audits come first: we trace each object your sellers touch and remove duplicates before any new automation is designed or built.",
  revops:
    "Activation work wires lead scoring and territory rules into revenue operations dashboards, so managers coach from numbers they already believe.",
  "how-it-works":
    "Stage one connects your systems, stage two enriches records, stage three activates workflows, and stage four hands over a documented playbook.",
  contact:
    "After the call you receive a written scope listing the crm transformation steps, owners, and the revenue operations outcomes we will measure.",
};

const routeIntro = (routeId: string): string => INTRO[routeId] as string;
const routeProcess = (routeId: string): string => PROCESS[routeId] as string;

type Defect = "heading-as-quote" | "shared-process" | "near-duplicate" | "build-mechanics";

function route(routeId: string, defects: readonly Defect[]): StructuredContentRoute {
  const hero = [
    { kind: "paragraph" as const, text: routeIntro(routeId) },
    ...(defects.includes("heading-as-quote")
      ? [{ kind: "quote" as const, text: H1, attribution: "Quantum AI Partners" }]
      : []),
    ...(defects.includes("build-mechanics")
      ? [{ kind: "paragraph" as const, text: CONTACT_LEAK }]
      : []),
  ];
  const process = defects.includes("shared-process")
    ? [{ kind: "paragraph" as const, text: PROCESS_STEP }]
    : defects.includes("near-duplicate")
      ? [
          { kind: "paragraph" as const, text: PROCESS_STEP },
          { kind: "paragraph" as const, text: PROCESS_STEP_NEAR },
        ]
      : [{ kind: "paragraph" as const, text: routeProcess(routeId) }];
  return {
    route_id: routeId,
    path: "/",
    metadata: { title: `Quantum AI Partners ${routeId}`, description: `CRM help for ${routeId}` },
    sections: [
      { section_id: "hero", heading: H1, blocks: hero },
      { section_id: "process", heading: "How we work", blocks: process },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
}

const pass: ContentValidationVerdict = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};

interface Call {
  routeId: string;
  repair: boolean;
  evidence: string[];
  earlier: Array<{ route_id: string; text: string }>;
}

/**
 * Writes each route with `defects(routeId)` on its first attempt. On the repair
 * it drops a defect only when the repair evidence names it, unless `stubborn`.
 */
function fakeModel(defects: (routeId: string) => Defect[], stubborn = false) {
  const calls: Call[] = [];
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
      const routeId = args.purpose.split(":")[1] as string;
      const prompt = JSON.parse(args.userPrompt.split("\n\n---\n")[0] ?? "{}") as {
        repair_instructions?: { failed_requirements: string[] };
        do_not_reuse_from_earlier_routes?: {
          sentences: Array<{ route_id: string; text: string }>;
        };
      };
      const evidence = prompt.repair_instructions?.failed_requirements ?? [];
      calls.push({
        routeId,
        repair: Boolean(prompt.repair_instructions),
        evidence,
        earlier: prompt.do_not_reuse_from_earlier_routes?.sentences ?? [],
      });
      const told = (code: string) => !stubborn && evidence.some((line) => line.startsWith(code));
      const remaining = defects(routeId).filter((defect) => {
        if (defect === "heading-as-quote") return !told("HEADING_RESTATED");
        if (defect === "build-mechanics") return !told("BUILD_MECHANICS_IN_COPY");
        return !told("DUPLICATE_CONTENT");
      });
      return args.validate(
        route(routeId, prompt.repair_instructions ? remaining : defects(routeId)),
      );
    },
  } as unknown as LlmService;
  return { llm, calls };
}

async function produce(llm: LlmService, routes = QAP_ROUTES) {
  return createStructuredContentPackageWithEvidence(
    { client_id: "qap", build_id: "qap-build", page_content_contract: contract(routes) },
    { llm },
  );
}

/* ── Similarity definition ───────────────────────────────────────────────────── */

describe("shingleSimilarity — Website-Bot checker parity", () => {
  it("never compares a unit shorter than 8 words", () => {
    expect(shingleSimilarity("one two three four five six seven", "one two three")).toBeNull();
  });

  it("scores identical text 1 and the canary near-duplicate at or above the limit", () => {
    expect(shingleSimilarity(PROCESS_STEP, PROCESS_STEP)).toBe(1);
    const near = shingleSimilarity(PROCESS_STEP, PROCESS_STEP_NEAR);
    expect(near).not.toBeNull();
    expect(near as number).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
    expect(near as number).toBeLessThan(1);
  });

  it("ignores case and punctuation", () => {
    expect(shingleSimilarity(H1, H1.toUpperCase().replaceAll(".", "!"))).toBe(1);
  });
});

/* ── Canary regressions (deterministic findings) ─────────────────────────────── */

describe("findContentFindings — canary regressions", () => {
  const home = contractRoute("home", "/");

  it("flags the H1 restated as a self-attributed quote", () => {
    const findings = findContentFindings(route("home", ["heading-as-quote"]), home, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^HEADING_RESTATED: sections\.hero\.blocks\[1\] \(quote\)/);
    expect(findings[0]).toContain("sections.hero.heading");
  });

  it("flags a near-duplicate paragraph pair within a route", () => {
    const findings = findContentFindings(route("home", ["near-duplicate"]), home, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^DUPLICATE_CONTENT: sections\.process\.blocks\[1\]/);
    expect(findings[0]).toContain("repeats sections.process.blocks[0]");
  });

  it("flags a process step already used on an earlier route, naming that route", () => {
    const earlier = contentUnits(route("home", ["shared-process"]));
    const findings = findContentFindings(
      route("how-it-works", ["shared-process"]),
      contractRoute("how-it-works", "/how-it-works"),
      earlier,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('repeats route "home" sections.process.blocks[0]');
  });

  it("flags /contact copy that describes the build", () => {
    const findings = findContentFindings(
      route("contact", ["build-mechanics"]),
      contractRoute("contact", "/contact"),
      [],
    );
    const terms = findings.map((finding) => /says "([^"]+)"/.exec(finding)?.[1]);
    expect(terms).toEqual(["endpoint", "https", "invented"]);
    for (const finding of findings) expect(finding).toMatch(/^BUILD_MECHANICS_IN_COPY: /);
  });

  it("allows a build term a verified fact uses (a client that sells endpoints)", () => {
    const sellsEndpoints = contractRoute("contact", "/contact");
    sellsEndpoints.business_facts = [
      ...FACTS,
      {
        fact_id: "f-product",
        key: "product",
        value: "a managed HTTPS lead endpoint, invented in-house",
        verified: true,
        source_refs: ["spec"],
      },
    ];
    expect(findContentFindings(route("contact", ["build-mechanics"]), sellsEndpoints, [])).toEqual(
      [],
    );
  });

  it("passes clean, route-specific copy", () => {
    expect(findContentFindings(route("home", []), contractRoute("home", "/"), [])).toEqual([]);
  });
});

/* ── Inside the single bounded repair ────────────────────────────────────────── */

describe("structured content — duplicates are repair evidence inside the one repair", () => {
  it("canary H1-as-quote: the repair receives the exact evidence and the route seals on attempt two", async () => {
    const { llm, calls } = fakeModel((id) => (id === "home" ? ["heading-as-quote"] : []));
    const { artifact, evidence } = await produce(llm, [QAP_ROUTES[0] as (typeof QAP_ROUTES)[0]]);
    expect(calls.map((call) => call.repair)).toEqual([false, true]);
    expect(calls[1]?.evidence.some((line) => line.startsWith("HEADING_RESTATED"))).toBe(true);
    expect(evidence.route_results[0]).toMatchObject({ generation_calls: 2, repair_attempts: 1 });
    const hero = artifact.payload.routes[0]?.sections[0];
    expect(hero?.blocks.some((block) => block.kind === "quote")).toBe(false);
  });

  it("canary /contact leak: build mechanics are repaired, never silently deleted", async () => {
    const { llm, calls } = fakeModel((id) => (id === "contact" ? ["build-mechanics"] : []));
    await produce(llm, [QAP_ROUTES[4] as (typeof QAP_ROUTES)[0]]);
    expect(
      calls[1]?.evidence.filter((line) => line.startsWith("BUILD_MECHANICS_IN_COPY")),
    ).toHaveLength(3);
  });

  it("fails typed, with the evidence, when the repair still repeats content (no second repair)", async () => {
    const { llm, calls } = fakeModel(() => ["near-duplicate"], true);
    const error = await produce(llm, [QAP_ROUTES[0] as (typeof QAP_ROUTES)[0]]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContentRequirementUnsatisfiedError);
    expect((error as ContentRequirementUnsatisfiedError).code).toBe(
      "CONTENT_REQUIREMENT_UNSATISFIED",
    );
    expect((error as ContentRequirementUnsatisfiedError).failedRequirements[0]).toMatch(
      /^DUPLICATE_CONTENT: /,
    );
    expect(calls).toHaveLength(2);
  });
});

/* ── Cross-route dedupe across the QAP 5-route shape ─────────────────────────── */

describe("structured content — cross-route dedupe across the QAP 5 routes", () => {
  it("repairs the canary's shared process paragraphs on later routes and seals a package with no cross-page duplicates", async () => {
    const sharing = new Set(["home", "crm-transformation", "how-it-works"]);
    const { llm, calls } = fakeModel((id) => (sharing.has(id) ? ["shared-process"] : []));
    const { artifact, evidence } = await produce(llm);

    // "/" is first, so its process paragraph is accepted; the two later routes
    // that repeat it are told exactly which route they repeat, and repaired.
    expect(evidence.repaired_route_ids).toEqual(["crm-transformation", "how-it-works"]);
    const repairOf = (id: string) => calls.find((call) => call.routeId === id && call.repair);
    expect(repairOf("crm-transformation")?.evidence.join("\n")).toContain('route "home"');
    expect(repairOf("how-it-works")?.evidence.join("\n")).toContain('route "home"');

    // Later routes are shown what earlier routes already said.
    const firstHowItWorks = calls.find((call) => call.routeId === "how-it-works" && !call.repair);
    expect(firstHowItWorks?.earlier.some((unit) => unit.text === PROCESS_STEP)).toBe(true);

    // No body unit of 8+ words is repeated anywhere in the sealed package.
    const units = artifact.payload.routes
      .flatMap((sealed) => contentUnits(sealed))
      .filter((unit) => !["heading", "subheading", "eyebrow"].includes(unit.kind));
    for (const [index, unit] of units.entries()) {
      for (const other of units.slice(index + 1)) {
        const similarity = shingleSimilarity(unit.text, other.text);
        expect(similarity === null || similarity < DUPLICATE_SIMILARITY).toBe(true);
      }
    }
  });
});
