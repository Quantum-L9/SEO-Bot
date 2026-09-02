/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The evidence pack is the boundary between the database and the model. Every
 * leak that matters — a PostHog key, a client domain, a prospect's email — would
 * leave through here, and would leave silently.
 *
 * So redaction is tested from the hostile direction: hand the builder evidence
 * that CONTAINS those things and assert they do not survive, rather than handing
 * it clean input and confirming nothing broke.
 */

import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTIONS_BY_OPPORTUNITY,
  allowedActionsFor,
  assertPackIsRedacted,
  buildEvidencePack,
  FORBIDDEN_ACTIONS,
  FORBIDDEN_PACK_KEYS,
  redactEvidence,
} from "../../src/intelligence/evidence-pack.js";
import type { ScoredOpportunity } from "../../src/intelligence/types.js";

const CLIENT = { industry: "legal", market: "NC" };

function opportunity(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    clientId: "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04",
    opportunityType: "keyword_drop_plus_page_experience",
    title: "Ranking loss on a page with poor experience",
    description: "A keyword lost ground on a slow page.",
    targetUrl: "/personal-injury-lawyer",
    targetKeyword: "personal injury lawyer hickory nc",
    expectedImpact: 9,
    effort: 4,
    risk: 2,
    urgency: 0.75,
    confidence: 0.85,
    score: 82.4,
    fingerprint: "abc123",
    signals: [],
    evidence: { ranking: { previous: 5, current: 13 } },
    ...overrides,
  };
}

describe("redactEvidence", () => {
  it("removes credential-shaped keys at any depth", () => {
    const redacted = redactEvidence({
      outer: { posthog_api_key: "phx_live_secret", nested: { api_key: "sk-123", keep: 1 } },
    }) as Record<string, Record<string, unknown>>;

    expect(JSON.stringify(redacted)).not.toContain("phx_live_secret");
    expect(JSON.stringify(redacted)).not.toContain("sk-123");
    expect(redacted.outer.nested).toEqual({ keep: 1 });
  });

  it("removes client identity keys", () => {
    const redacted = redactEvidence({
      client_name: "Acme Legal",
      domain: "acme.example",
      lcp: 3800,
    });
    expect(redacted).toEqual({ lcp: 3800 });
  });

  it("reduces an absolute URL to a path so the domain does not ride along", () => {
    expect(redactEvidence("https://acme.example/pricing?x=1")).toBe("/pricing?x=1");
    expect(redactEvidence("https://acme.example")).toBe("/");
  });

  it("replaces an email address rather than passing it through", () => {
    expect(redactEvidence("reach me at editor@blog.example")).toBe("[redacted:email]");
  });

  it("walks arrays as well as objects", () => {
    const redacted = redactEvidence([
      { contact_email: "a@b.example", domain_rating: 60 },
      "https://acme.example/x",
    ]) as unknown[];
    expect(redacted).toEqual([{ domain_rating: 60 }, "/x"]);
  });

  it("leaves numbers, booleans and null untouched", () => {
    expect(redactEvidence({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
  });
});

describe("assertPackIsRedacted", () => {
  it("accepts a clean pack", () => {
    expect(() => assertPackIsRedacted({ evidence: { lcp: 3800, path: "/pricing" } })).not.toThrow();
  });

  it("throws — rather than quietly dropping — on a forbidden key", () => {
    expect(() => assertPackIsRedacted({ evidence: { posthog_api_key: "x" } })).toThrow(
      /forbidden key "posthog_api_key"/,
    );
  });

  it("throws on an absolute URL, which carries a domain", () => {
    expect(() => assertPackIsRedacted({ url: "https://acme.example/x" })).toThrow(/absolute URL/);
  });

  it("throws on an email address", () => {
    expect(() => assertPackIsRedacted({ note: "ping editor@blog.example" })).toThrow(/email/);
  });

  it("names the path to the offending value", () => {
    expect(() => assertPackIsRedacted({ a: [{ b: { domain: "x" } }] })).toThrow(/pack\.a\[0\]\.b/);
  });
});

describe("buildEvidencePack", () => {
  it("identifies the client only by industry and market", () => {
    const pack = buildEvidencePack(opportunity(), CLIENT);
    expect(pack.client).toEqual({ industry: "legal", market: "NC" });
    expect(JSON.stringify(pack)).not.toContain("3f1b0c4e");
  });

  it("survives hostile evidence by redacting it", () => {
    const pack = buildEvidencePack(
      opportunity({
        evidence: {
          client_name: "Acme Legal",
          domain: "acme.example",
          contact_email: "editor@blog.example",
          posthog_api_key: "phx_live_secret",
          competitor: { url: "https://competitor.example/page" },
          lcp: 3800,
        },
      }),
      CLIENT,
    );

    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("Acme Legal");
    expect(serialized).not.toContain("acme.example");
    expect(serialized).not.toContain("editor@blog.example");
    expect(serialized).not.toContain("phx_live_secret");
    expect(serialized).not.toContain("competitor.example");
    expect(serialized).toContain("3800");
  });

  it("states both what may and what may not be proposed", () => {
    const pack = buildEvidencePack(opportunity(), CLIENT);
    expect(pack.allowed_actions).toContain("faq_content_add");
    expect(pack.forbidden_actions).toContain("site_redesign");
    expect(pack.forbidden_actions).toContain("deploy_without_approval");
  });

  it("offers no actions at all for a diagnostic-only opportunity", () => {
    const pack = buildEvidencePack(opportunity({ opportunityType: "pipeline_repair" }), CLIENT);
    expect(pack.allowed_actions).toEqual([]);
  });

  it("carries an unknown market as null rather than inventing one", () => {
    const pack = buildEvidencePack(opportunity(), { industry: "legal", market: null });
    expect(pack.client.market).toBeNull();
  });
});

describe("the forbidden-key set tracks the real schema", () => {
  // The redaction list is only as good as its coverage of the columns that
  // actually hold secrets. `clients.posthogApiKey` maps to `posthog_api_key` on
  // the wire, so both spellings have to be covered — a rename in schema.ts that
  // is not mirrored here would silently reopen the leak.
  it("covers the credential columns the clients table actually has", () => {
    const credentialColumns = [
      "posthog_api_key",
      "posthogApiKey",
      "posthog_project_id",
      "posthogProjectId",
    ];
    for (const column of credentialColumns) {
      expect(FORBIDDEN_PACK_KEYS.has(column.toLowerCase()), column).toBe(true);
    }
  });

  it("covers client identity and contact PII in both snake and camel spellings", () => {
    for (const key of [
      "client_name",
      "clientName",
      "domain",
      "contact_email",
      "contactEmail",
      "config",
    ]) {
      expect(FORBIDDEN_PACK_KEYS.has(key.toLowerCase()), key).toBe(true);
    }
  });
});

describe("action allow-lists", () => {
  it("never allows a forbidden action for any opportunity type", () => {
    for (const [opportunityType, actions] of Object.entries(ALLOWED_ACTIONS_BY_OPPORTUNITY)) {
      for (const action of actions) {
        expect(FORBIDDEN_ACTIONS, `${opportunityType} → ${action}`).not.toContain(action);
      }
    }
  });

  it("returns an empty list for an unknown opportunity type instead of everything", () => {
    expect(allowedActionsFor("not_a_real_type")).toEqual([]);
  });

  it("forbids every CRITICAL-tier action from the execution policy taxonomy", () => {
    for (const critical of [
      "site_redesign",
      "seo_strategy_overhaul",
      "domain_migration",
      "domain_change",
      "bulk_page_delete",
      "bulk_redirect_change",
      "hosting_migration",
    ]) {
      expect(FORBIDDEN_ACTIONS).toContain(critical);
    }
  });
});
