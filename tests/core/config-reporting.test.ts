/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

/**
 * The reporting agent key and the operator key must be different secrets.
 *
 * Sharing one collapses the audience split silently: the auth hook checks the
 * operator key first, so an "agent" presenting the shared secret resolves to the
 * OPERATOR audience and receives client names, domains and contact PII — the
 * exact leak the masked plane exists to prevent. Nothing would look wrong; the
 * agent would simply start getting richer answers.
 *
 * loadConfig calls process.exit(1) on a validation failure, so the guard is
 * exercised through a stubbed exit rather than by crashing the test worker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/seo",
  REDIS_URL: "redis://localhost:6379",
  POSTHOG_API_URL: "https://posthog.example",
  POSTHOG_PERSONAL_API_KEY: "phx_test",
  DATAFORSEO_LOGIN: "login",
  DATAFORSEO_PASSWORD: "password",
  PAGESPEED_API_KEY: "psi",
  OPENROUTER_API_KEY: "or",
  PERPLEXITY_API_KEY: "px",
};

const originalEnv = process.env;

async function loadWith(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...env } as NodeJS.ProcessEnv;

  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const errors: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  try {
    const { loadConfig } = await import("../../src/core/config.js");
    return { config: loadConfig(), errors, exited: false };
  } catch (error) {
    return { config: null, errors, exited: String(error).includes("process.exit") };
  } finally {
    exit.mockRestore();
    consoleError.mockRestore();
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
  vi.resetModules();
});

describe("reporting credential separation", () => {
  it("refuses to start when the agent key equals the operator key", async () => {
    const result = await loadWith({
      OPERATOR_API_KEY: "same-secret",
      REPORTING_AGENT_API_KEY: "same-secret",
    });

    expect(result.exited).toBe(true);
    expect(result.errors.join("\n")).toContain("REPORTING_AGENT_API_KEY");
    expect(result.errors.join("\n")).toMatch(/must not equal OPERATOR_API_KEY/);
  });

  it("starts when the two keys are distinct", async () => {
    const result = await loadWith({
      OPERATOR_API_KEY: "operator-secret",
      REPORTING_AGENT_API_KEY: "agent-secret",
    });

    expect(result.exited).toBe(false);
    expect(result.config?.REPORTING_AGENT_API_KEY).toBe("agent-secret");
  });

  it("starts with no agent key at all — the agent surface is opt-in", async () => {
    const result = await loadWith({ OPERATOR_API_KEY: "operator-secret" });
    expect(result.exited).toBe(false);
    expect(result.config?.REPORTING_AGENT_API_KEY).toBeUndefined();
  });
});

describe("intelligence plane defaults", () => {
  it("ships conservative defaults that need no operator configuration", async () => {
    const result = await loadWith({});
    expect(result.exited).toBe(false);
    expect(result.config?.INTELLIGENCE_MIN_OPPORTUNITY_SCORE).toBe(20);
    expect(result.config?.INTELLIGENCE_MAX_ACTIONS_PER_RUN).toBe(3);
    expect(result.config?.INTELLIGENCE_SIGNAL_COOLDOWN_DAYS).toBe(7);
    expect(result.config?.INTELLIGENCE_BASELINE_DAYS).toBe(14);
    expect(result.config?.INTELLIGENCE_MEASUREMENT_DAYS).toBe(28);
  });

  it("accepts an operator override of the action ceiling", async () => {
    const result = await loadWith({ INTELLIGENCE_MAX_ACTIONS_PER_RUN: "1" });
    expect(result.config?.INTELLIGENCE_MAX_ACTIONS_PER_RUN).toBe(1);
  });

  it("allows zero actions per run as a full stop on proposals", async () => {
    const result = await loadWith({ INTELLIGENCE_MAX_ACTIONS_PER_RUN: "0" });
    expect(result.exited).toBe(false);
    expect(result.config?.INTELLIGENCE_MAX_ACTIONS_PER_RUN).toBe(0);
  });

  it("rejects a negative or non-integer action ceiling rather than coercing it", async () => {
    expect((await loadWith({ INTELLIGENCE_MAX_ACTIONS_PER_RUN: "-1" })).exited).toBe(true);
    expect((await loadWith({ INTELLIGENCE_MAX_ACTIONS_PER_RUN: "2.5" })).exited).toBe(true);
  });
});
