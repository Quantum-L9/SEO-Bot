/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * QAP canary8 (qap-canary8-20261121T054830Z) regressions. Fake transports only.
 *
 * 1. /crm-transformation's one bounded repair failed with
 *    `422 STRUCTURED_CONTENT_SHAPE_INVALID: $: LLM did not return valid JSON
 *    (response length=9217)`. The repair used the full 12,000-token cap, and
 *    9,217 characters is about 2.5k tokens, so the cap did not cut it. Fences
 *    and prose wrappers are already stripped by parseJsonFromLlm. What reaches
 *    the parser as an unbalanced body with no `length` finish is a reply
 *    DeepSeek interrupted (finish_reason insufficient_system_resource, aborted
 *    or content_filter). Such a reply is now typed LLM_OUTPUT_TRUNCATED and is
 *    never parsed. A reply that DID finish ("stop") with invalid JSON is still
 *    rejected: the parser was not loosened.
 * 2. The first draft reused "/"'s process steps and FAQ answers. Route N's
 *    prompt now lists the exact earlier sentences and names the shared
 *    components and repeated FAQ questions to frame for this route.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactRef,
  type PageContentContractArtifact,
  type PageContentContractRoute,
  type PageContentContractV1,
  type StructuredContentRoute,
  sealIntelligenceArtifact,
  WEBSITE_INTELLIGENCE_SCHEMAS,
} from "@quantum-l9/bot-interop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentUnits,
  DUPLICATE_SIMILARITY,
  shingleSimilarity,
} from "../../src/build-intelligence/content-duplication.js";
import {
  createDeepSeekBuildIntelligenceLlm,
  DeepSeekOutputTruncatedError,
  isIncompleteFinish,
} from "../../src/build-intelligence/deepseek-llm.js";
import type { ContentValidationVerdict } from "../../src/build-intelligence/schema-guards.js";
import {
  createStructuredContentPackageWithEvidence,
  StructuredContentShapeError,
} from "../../src/build-intelligence/structured-content.js";
import type { LlmService } from "../../src/services/llm.js";
import { parseJsonFromLlm } from "../../src/services/llm-parse.js";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/* ── Contract: QAP routes sharing a process component and an FAQ question ───── */

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

const SHARED_QUESTION = "How long does an engagement take?";

function contractRoute(routeId: string, path: string, purpose: string): PageContentContractRoute {
  const section = (sectionId: string, questions: string[] = []) => ({
    section_id: sectionId,
    component_class: sectionId,
    objective: `explain ${sectionId}`,
    slots: ["service_overview" as const],
    content_requirements: {
      requirement_ids: [`${routeId}-${sectionId}`],
      topics: ["crm transformation"],
      entities: ["revenue operations"],
      questions,
    },
    allowed_fact_ids: ["f-name", "f-model"],
    proof_requirements: [],
    acceptance_tests: [],
  });
  return {
    route_id: routeId,
    path,
    purpose,
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: `${purpose} consulting`,
      supporting_queries: [],
      topics: ["crm transformation"],
      entities: ["revenue operations"],
    },
    metadata_requirements: { title: ["name the service"], description: ["<160 chars"] },
    business_facts: FACTS,
    sections: [section("hero"), section("process"), section("faq", [SHARED_QUESTION])],
    internal_link_requirements: [],
    forbidden_claims: [],
    acceptance_tests: [],
  };
}

const ROUTES = [
  { route_id: "home", path: "/", purpose: "crm transformation" },
  { route_id: "crm-transformation", path: "/crm-transformation", purpose: "crm cleanup" },
];

function contract(routes = ROUTES): PageContentContractArtifact {
  const payload: PageContentContractV1 = {
    schema: WEBSITE_INTELLIGENCE_SCHEMAS.pageContentContract,
    compiler: { name: "website-content-contract-compiler", version: "1.0.0", warnings: [] },
    inputs: {
      website_build_blueprint: dummyRef,
      seo_content_blueprint: { ...dummyRef, artifact_type: "seo_content_blueprint" },
      business_facts_digest: "abc",
    },
    routes: routes.map((route) => contractRoute(route.route_id, route.path, route.purpose)),
  };
  return sealIntelligenceArtifact({
    artifact_type: "page_content_contract",
    client_id: "qap",
    build_id: "qap-canary8",
    producer: { repo: "Website-Bot", version: "1.0.0" },
    payload,
  });
}

/* ── Route copy ──────────────────────────────────────────────────────────────── */

const HOME_STEPS = [
  "Connect: bring existing CRM and relevant enterprise records into a coherent analysis for revenue operations.",
  "Enrich and Transform: clean, deduplicate and enrich every account so crm transformation rests on trusted data.",
  "Activate RevOps: wire scoring, routing and forecasting into the revenue operations workflows your team already uses.",
  "Close Deals: give sellers one view of each buyer so crm transformation turns into signed contracts.",
];
const HOME_FAQ_ANSWER =
  "Most Quantum AI Partners engagements run eight to twelve weeks as remote-first consulting, with crm transformation milestones every two weeks.";

const CRM_STEPS = [
  "Audit the objects: we map every field your sellers touch before crm cleanup changes a single record.",
  "Merge the duplicates: accounts and contacts are matched once, so revenue operations reports finally agree.",
  "Rebuild the stages: pipeline stages are redefined around how your buyers actually move toward a decision.",
  "Hand over the rules: your admins receive the cleanup rules so the CRM stays clean after we leave.",
];
const CRM_FAQ_ANSWER =
  "A crm cleanup on its own usually takes four to six weeks of remote-first consulting, depending on how many duplicate accounts we merge.";

function route(
  routeId: string,
  steps: readonly string[],
  faqAnswer: string,
  intro: string,
): StructuredContentRoute {
  return {
    route_id: routeId,
    path: "/",
    metadata: { title: `Quantum AI Partners ${routeId}`, description: `CRM help for ${routeId}` },
    sections: [
      {
        section_id: "hero",
        heading: "Your CRM, working",
        blocks: [{ kind: "paragraph", text: intro }],
      },
      {
        section_id: "process",
        heading: "How we work",
        blocks: [{ kind: "steps", items: [...steps] }],
      },
      {
        section_id: "faq",
        heading: "Questions",
        blocks: [
          {
            kind: "paragraph",
            text: `Answers about ${routeId} work: crm transformation and revenue operations, delivered remote-first.`,
          },
        ],
      },
    ],
    faqs: [{ question: SHARED_QUESTION, answer: faqAnswer }],
    internal_links: [],
    schema_content_inputs: {},
  };
}

const HOME_INTRO =
  "Quantum AI Partners turns a stalled CRM into revenue operations your leaders trust, through crm transformation delivered as remote-first consulting.";
const CRM_INTRO =
  "A crm cleanup is where revenue operations gets honest data back: Quantum AI Partners removes the drift that makes every forecast argue with itself.";

const pass: ContentValidationVerdict = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};

/* ── 1. The invalid repair JSON (DeepSeek client, fake transport) ────────────── */

/** A ~9 KB repair-shaped reply: a full route JSON cut at 9,217 characters. */
function cutRepairReply(): string {
  const long = Array.from(
    { length: 80 },
    (_, index) =>
      `Step ${index + 1}: Quantum AI Partners reviews crm transformation and revenue operations decisions for this page in detail.`,
  );
  const full = JSON.stringify(
    route("crm-transformation", long, CRM_FAQ_ANSWER, CRM_INTRO),
    null,
    2,
  );
  expect(full.length).toBeGreaterThan(9_217);
  return full.slice(0, 9_217);
}

function deepSeekBody(content: string, finishReason: string, completionTokens: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 7_400,
        completion_tokens: completionTokens,
        total_tokens: 7_400 + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let ledgerDir: string;
beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), "canary8-"));
});
afterEach(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
});

/**
 * Generation calls answer from `generations` in order; semantic validation
 * always passes. Requests are told apart by their system prompt.
 */
function deepSeekWith(generations: Array<() => Response>) {
  const requests: Array<{ max_tokens: number; generation: boolean }> = [];
  let next = 0;
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    const generation =
      body.messages[0]?.content.includes("sole owner of final website prose") ?? false;
    requests.push({ max_tokens: body.max_tokens, generation });
    if (!generation) return deepSeekBody(JSON.stringify(pass), "stop", 40);
    const reply = generations[next++];
    if (!reply) throw new Error("unexpected extra generation call");
    return reply();
  });
  const llm = createDeepSeekBuildIntelligenceLlm({
    env: { DEEPSEEK_API_KEY: "test-key" },
    transport,
    ledgerDir,
  });
  return { llm, requests };
}

/** A first draft that repeats one step inside the route, so the one repair runs. */
const draftWithDuplicate = () =>
  deepSeekBody(
    JSON.stringify(
      route(
        "crm-transformation",
        [CRM_STEPS[0] as string, CRM_STEPS[0] as string],
        CRM_FAQ_ANSWER,
        CRM_INTRO,
      ),
    ),
    "stop",
    900,
  );

const oneRoute = [ROUTES[1] as (typeof ROUTES)[number]];

describe("canary8 regression — an interrupted repair reply is typed truncation, never a JSON error", () => {
  it("the canary's message is what parsing a cut ~9 KB reply produces", () => {
    expect(() => parseJsonFromLlm(cutRepairReply())).toThrow(
      "LLM did not return valid JSON (response length=9217)",
    );
  });

  it("types a repair interrupted by insufficient_system_resource as LLM_OUTPUT_TRUNCATED with token counts", async () => {
    const { llm, requests } = deepSeekWith([
      draftWithDuplicate,
      () => deepSeekBody(cutRepairReply(), "insufficient_system_resource", 2_412),
    ]);
    const error = await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-canary8", page_content_contract: contract(oneRoute) },
      { llm: llm as unknown as LlmService },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeepSeekOutputTruncatedError);
    expect(error).toMatchObject({
      code: "LLM_OUTPUT_TRUNCATED",
      finishReason: "insufficient_system_resource",
      outputTokens: 2_412,
      promptTokens: 7_400,
      responseLength: 9_217,
      site: {
        operation: "STRUCTURED_CONTENT_GENERATION",
        purpose: "structured-content:crm-transformation",
      },
    });
    // It was the route's one bounded repair: the second generation call. (The
    // route repair is its own client call, so the client labels it "initial".)
    expect(requests.filter((request) => request.generation)).toHaveLength(2);
    expect(error).not.toBeInstanceOf(StructuredContentShapeError);
  });

  it("sizes the repair like the first draft: a full route's 12,000-token cap, far above a 9 KB reply", async () => {
    const { llm, requests } = deepSeekWith([
      draftWithDuplicate,
      () => deepSeekBody(cutRepairReply(), "aborted", 2_412),
    ]);
    await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-canary8", page_content_contract: contract(oneRoute) },
      { llm: llm as unknown as LlmService },
    ).catch(() => undefined);
    const generations = requests.filter((request) => request.generation);
    expect(generations.map((request) => request.max_tokens)).toEqual([12_000, 12_000]);
  });

  it.each(["insufficient_system_resource", "aborted", "content_filter", "length"])(
    "treats finish_reason %s as an incomplete reply",
    (reason) => {
      expect(isIncompleteFinish(reason)).toBe(true);
    },
  );

  it("treats only stop as a finished reply, and a missing reason as unproven", () => {
    expect(isIncompleteFinish("stop")).toBe(false);
    expect(isIncompleteFinish(null)).toBe(true);
    expect(isIncompleteFinish(undefined)).toBe(true);
  });

  it("still rejects a reply that finished (stop) with invalid JSON: the parser was not loosened", async () => {
    const { llm } = deepSeekWith([
      draftWithDuplicate,
      () => deepSeekBody(cutRepairReply(), "stop", 2_412),
    ]);
    const error = await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-canary8", page_content_contract: contract(oneRoute) },
      { llm: llm as unknown as LlmService },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredContentShapeError);
    expect((error as Error).message).toContain(
      "LLM did not return valid JSON (response length=9217)",
    );
  });
});

/* ── 2. Cross-route: a duplicate first draft is repaired into new copy ───────── */

interface Seen {
  routeId: string;
  repair: boolean;
  evidence: string[];
  doNotReuse: string[];
  framing?: {
    shared_components: Array<{ section_id: string; also_on_routes: string[] }>;
    repeated_faq_questions: Array<{ question: string; also_on_routes: string[] }>;
  };
}

describe("canary8 regression — cross-route duplicates across the QAP routes", () => {
  it("lists the exact earlier sentences, names the shared components, and repairs a copied first draft into route-specific copy", async () => {
    const seen: Seen[] = [];
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
          do_not_reuse_from_earlier_routes?: { sentences: Array<{ text: string }> };
          route_specific_framing?: Seen["framing"];
        };
        const doNotReuse = (prompt.do_not_reuse_from_earlier_routes?.sentences ?? []).map(
          (sentence) => sentence.text,
        );
        seen.push({
          routeId,
          repair: Boolean(prompt.repair_instructions),
          evidence: prompt.repair_instructions?.failed_requirements ?? [],
          doNotReuse,
          framing: prompt.route_specific_framing,
        });
        if (routeId === "home")
          return args.validate(route("home", HOME_STEPS, HOME_FAQ_ANSWER, HOME_INTRO));
        // The canary's first draft: "/"'s steps and FAQ answer, copied.
        const told = prompt.repair_instructions?.failed_requirements.some((line) =>
          line.startsWith("DUPLICATE_CONTENT"),
        );
        return args.validate(
          told
            ? route("crm-transformation", CRM_STEPS, CRM_FAQ_ANSWER, CRM_INTRO)
            : route("crm-transformation", HOME_STEPS, HOME_FAQ_ANSWER, CRM_INTRO),
        );
      },
    } as unknown as LlmService;

    const { artifact, evidence } = await createStructuredContentPackageWithEvidence(
      { client_id: "qap", build_id: "qap-canary8", page_content_contract: contract() },
      { llm },
    );

    const firstCrm = seen.find((call) => call.routeId === "crm-transformation" && !call.repair);
    // Exact, untruncated sentences from the earlier route.
    for (const step of HOME_STEPS) expect(firstCrm?.doNotReuse).toContain(step);
    expect(firstCrm?.doNotReuse).toContain(HOME_FAQ_ANSWER);
    // Shared components and the repeated FAQ question are named for framing.
    expect(firstCrm?.framing?.shared_components.map((entry) => entry.section_id)).toEqual([
      "hero",
      "process",
      "faq",
    ]);
    expect(firstCrm?.framing?.repeated_faq_questions).toEqual([
      { question: SHARED_QUESTION, also_on_routes: ["home"] },
    ]);
    // The first route has nothing to avoid.
    expect(seen.find((call) => call.routeId === "home")?.doNotReuse).toEqual([]);

    // The copied draft is repaired once, with the exact evidence, and seals.
    const repair = seen.find((call) => call.routeId === "crm-transformation" && call.repair);
    expect(repair?.evidence.filter((line) => line.startsWith("DUPLICATE_CONTENT"))).toHaveLength(5);
    expect(evidence.repaired_route_ids).toEqual(["crm-transformation"]);

    // No body unit of 8+ words repeats anywhere in the sealed package.
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
