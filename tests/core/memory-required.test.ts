/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMemoryAliases,
  DEFAULT_L9_MEMORY_MODE,
  parseGraphitiMachineAliases,
} from "../../src/core/memory-aliases.js";

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

afterEach(() => {
  process.env = originalEnv;
  vi.resetModules();
});

describe("memory is required", () => {
  it("defaults mode to required", () => {
    expect(DEFAULT_L9_MEMORY_MODE).toBe("required");
  });

  it("refuses to start without L9_MEMORY_TOKEN or GRAPHITI_MCP_TOKEN", async () => {
    const result = await loadWith({ L9_MEMORY_MODE: "required" });
    expect(result.exited).toBe(true);
    expect(result.errors.join("\n")).toContain("L9_MEMORY_TOKEN");
  });

  it("aliases GRAPHITI_MCP_TOKEN into L9_MEMORY_TOKEN", async () => {
    const result = await loadWith({ GRAPHITI_MCP_TOKEN: "machine-token" });
    expect(result.exited).toBe(false);
    expect(result.config?.L9_MEMORY_MODE).toBe("required");
    expect(result.config?.L9_MEMORY_TOKEN).toBe("machine-token");
    expect(result.config?.L9_MEMORY_URL).toBeTruthy();
  });

  it("keeps an explicit L9_MEMORY_TOKEN over the Graphiti alias", async () => {
    const result = await loadWith({
      L9_MEMORY_TOKEN: "bot-token",
      GRAPHITI_MCP_TOKEN: "machine-token",
    });
    expect(result.config?.L9_MEMORY_TOKEN).toBe("bot-token");
  });

  it("still allows an explicit optional degrade in tests", async () => {
    const result = await loadWith({ L9_MEMORY_MODE: "optional" });
    expect(result.exited).toBe(false);
    expect(result.config?.L9_MEMORY_MODE).toBe("optional");
  });

  it("Gate 5 Graphiti placeholders keep mode required and copy the token", async () => {
    const result = await loadWith({
      GRAPHITI_MCP_TOKEN: "live-suite-placeholder",
      GRAPHITI_MCP_URL: "https://graphiti.invalid",
    });
    expect(result.exited).toBe(false);
    expect(result.config?.L9_MEMORY_MODE).toBe("required");
    expect(result.config?.L9_MEMORY_TOKEN).toBe("live-suite-placeholder");
    expect(result.config?.L9_MEMORY_URL).toBe("https://graphiti.invalid");
  });

  it("Gate 5 job env in ci.yml sets GRAPHITI_MCP_TOKEN so the alias can fire", () => {
    const yml = readFileSync(".github/workflows/ci.yml", "utf8");
    const gate5 = yml.split("gate5:")[1] ?? "";
    expect(gate5).toContain("GRAPHITI_MCP_TOKEN: live-suite-placeholder");
    expect(gate5).toContain("GRAPHITI_MCP_URL: https://graphiti.invalid");
    expect(gate5).not.toContain("L9_MEMORY_MODE: disabled");
  });
});

describe("Graphiti machine alias parser", () => {
  it("copies only Graphiti keys", () => {
    const parsed = parseGraphitiMachineAliases(
      ["GRAPHITI_MCP_TOKEN=secret-value", "OPENAI_API_KEY=must-not-copy"].join("\n"),
    );
    expect(parsed).toEqual({ GRAPHITI_MCP_TOKEN: "secret-value" });
  });

  it("applyMemoryAliases sets required defaults on an empty env", () => {
    const env: NodeJS.ProcessEnv = {};
    applyMemoryAliases(env);
    expect(env.L9_MEMORY_MODE).toBe("required");
    expect(env.L9_MEMORY_URL).toBe("http://127.0.0.1:8100");
  });
});
