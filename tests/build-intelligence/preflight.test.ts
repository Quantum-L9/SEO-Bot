/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreflight } from "../../src/build-intelligence/preflight.js";

const EXPECTED_CHECKS = [
  "seo_bot_reachable",
  "seo_bot_machine_auth",
  "dataforseo_configured",
  "competitive_landscape_capability",
  "llm_provider_configured",
  "seo_content_blueprint_capability",
  "structured_content_capability",
  "bot_interop_compatible",
  "llm_router_compatible",
];

const ALL_KEYS = {
  SEO_BOT_API_KEY: "secret",
  DATAFORSEO_LOGIN: "login",
  DATAFORSEO_PASSWORD: "password",
  OPENROUTER_API_KEY: "or-key",
  PERPLEXITY_API_KEY: "pplx-key",
};

describe("preflight — nine REAL runtime checks (no hardcoded PASS)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns all nine checks with the oracle names, in order", () => {
    vi.stubEnv("SEO_BOT_API_KEY", ALL_KEYS.SEO_BOT_API_KEY);
    const report = runPreflight(true);
    expect(report.checks.map((c) => c.name)).toEqual(EXPECTED_CHECKS);
    expect(report.checks).toHaveLength(9);
    expect(report.preflight_id).toBeTruthy();
    expect(report.produced_at).toBeTruthy();
  });

  it("passes every check when all real prerequisites are configured and the request is machine-authed", () => {
    for (const [name, value] of Object.entries(ALL_KEYS)) vi.stubEnv(name, value);
    const report = runPreflight(true);
    for (const check of report.checks) {
      expect(check.status, `${check.name}: ${check.detail}`).toBe("PASS");
    }
  });

  it("FAILs dataforseo_configured and the derived landscape capability when the DataForSEO login is missing", () => {
    vi.stubEnv("SEO_BOT_API_KEY", ALL_KEYS.SEO_BOT_API_KEY);
    vi.stubEnv("OPENROUTER_API_KEY", ALL_KEYS.OPENROUTER_API_KEY);
    vi.stubEnv("PERPLEXITY_API_KEY", ALL_KEYS.PERPLEXITY_API_KEY);
    vi.stubEnv("DATAFORSEO_PASSWORD", ALL_KEYS.DATAFORSEO_PASSWORD);
    // DATAFORSEO_LOGIN deliberately unset.
    const report = runPreflight(true);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.dataforseo_configured!.status).toBe("FAIL");
    // Derived capability must not be reported PASS while its source is down.
    expect(byName.competitive_landscape_capability!.status).toBe("FAIL");
    expect(byName.seo_bot_reachable!.status).toBe("PASS");
  });

  it("FAILs seo_bot_machine_auth when the request was not machine-authenticated", () => {
    vi.stubEnv("SEO_BOT_API_KEY", ALL_KEYS.SEO_BOT_API_KEY);
    const report = runPreflight(false);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.seo_bot_machine_auth!.status).toBe("FAIL");
    expect(byName.seo_bot_machine_auth!.detail).toContain("not machine-authenticated");
  });

  it("FAILs seo_bot_machine_auth when the secret is not configured even if the request was authed", () => {
    // SEO_BOT_API_KEY deliberately unset — a missing secret must never read as PASS.
    const report = runPreflight(true);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.seo_bot_machine_auth!.status).toBe("FAIL");
    expect(byName.seo_bot_machine_auth!.detail).toContain("not configured");
  });

  it("FAILs llm_provider_configured and structured_content_capability when Perplexity is missing", () => {
    vi.stubEnv("SEO_BOT_API_KEY", ALL_KEYS.SEO_BOT_API_KEY);
    vi.stubEnv("OPENROUTER_API_KEY", ALL_KEYS.OPENROUTER_API_KEY);
    const report = runPreflight(true);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.llm_provider_configured!.status).toBe("FAIL");
    expect(byName.structured_content_capability!.status).toBe("FAIL");
  });
});
