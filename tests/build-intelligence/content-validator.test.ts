/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import type { PageContentContractRoute, StructuredContentRoute } from "@quantum-l9/bot-interop";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    DATABASE_URL: "postgres://localhost/test",
    REDIS_URL: "redis://localhost",
    POSTHOG_API_URL: "https://example.com",
    POSTHOG_PERSONAL_API_KEY: "x",
    DATAFORSEO_LOGIN: "l",
    DATAFORSEO_PASSWORD: "p",
    PAGESPEED_API_KEY: "k",
    OPENROUTER_API_KEY: "o",
    PERPLEXITY_API_KEY: "p2",
  }),
}));
vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({ executePolicyJson: vi.fn() }),
}));

import {
  detectForbiddenClaims,
  detectUnsupportedClaims,
  validateRouteDeterministic,
} from "../../src/build-intelligence/content-validator.js";

function contract(overrides: Partial<PageContentContractRoute> = {}): PageContentContractRoute {
  return {
    route_id: "home",
    path: "/",
    purpose: "primary landing",
    search_context: {
      primary_intent: "hire",
      secondary_intents: [],
      primary_query: "metal roofing",
      supporting_queries: [],
      topics: ["durability"],
      entities: ["metal roof"],
    },
    metadata_requirements: { title: ["include city"], description: ["<160 chars"] },
    business_facts: [],
    sections: [
      {
        section_id: "hero",
        component_class: "hero",
        objective: "convey primary offer",
        slots: ["primary_offer"],
        content_requirements: {
          requirement_ids: ["r1"],
          topics: ["durability"],
          entities: ["metal roof"],
          questions: ["how long?"],
        },
        allowed_fact_ids: [],
        proof_requirements: ["warranty"],
        acceptance_tests: ["mentions warranty"],
      },
    ],
    internal_link_requirements: [],
    forbidden_claims: ["lifetime free"],
    acceptance_tests: ["metadata present"],
    ...overrides,
  };
}

function route(text: string): StructuredContentRoute {
  return {
    route_id: "home",
    path: "/",
    metadata: { title: "Metal Roofing in Austin", description: "Durable metal roofs." },
    sections: [
      {
        section_id: "hero",
        heading: "Metal Roofing",
        blocks: [{ kind: "paragraph", text }],
      },
    ],
    faqs: [],
    internal_links: [],
    schema_content_inputs: {},
  };
}

describe("deterministic content validation", () => {
  it("rejects decades of experience when verified facts do not support it", () => {
    const generated = route("We have decades of experience installing durable metal roofs.");
    const unsupported = detectUnsupportedClaims(generated, []);
    expect(unsupported).toContain("years_experience");
  });

  it("allows a years-of-experience claim when a matching verified fact exists", () => {
    const generated = route("We have 12 years of experience installing durable metal roofs.");
    const unsupported = detectUnsupportedClaims(generated, [
      {
        fact_id: "f1",
        key: "years_in_business",
        value: 12,
        verified: true,
        source_refs: ["handoff"],
      },
    ]);
    expect(unsupported).not.toContain("years_experience");
  });

  it("detects forbidden claims by exact phrase", () => {
    const generated = route("Durable metal roofs with lifetime free service.");
    expect(detectForbiddenClaims(generated, ["lifetime free"])).toEqual(["lifetime free"]);
  });

  it("detects placeholder and empty content", () => {
    const placeholder = route("TODO: write durable metal roof copy");
    expect(
      validateRouteDeterministic(placeholder, contract()).some((f) => /placeholder/.test(f)),
    ).toBe(true);
  });

  it("requires exact route identity and section set", () => {
    const generated = route("Durable metal roofing.");
    generated.route_id = "other";
    const failures = validateRouteDeterministic(generated, contract());
    expect(failures.some((f) => /route_id/.test(f))).toBe(true);
  });
});
