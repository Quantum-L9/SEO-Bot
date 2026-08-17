/* L9_META
 * layer: test
 * role: architecture_invariant_test
 * status: active
 */

/**
 * Static architecture proof for the build-intelligence producer surface:
 *
 *   1. NO module under src/build-intelligence/ may call a provider SDK or a
 *      provider HTTP endpoint directly — every LLM call goes through
 *      @quantum-l9/llm-router, reached via src/services/llm.ts.
 *   2. The CompetitiveLandscape ranking path must not import an LLM service at
 *      all: rank authority is deterministic DataForSEO evidence, and the
 *      absence of the import is the structural proof.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PRODUCER_DIR = join(process.cwd(), "src", "build-intelligence");

function producerFiles(): string[] {
  return readdirSync(PRODUCER_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(PRODUCER_DIR, name));
}

/** Direct-provider markers that would bypass the router. */
const PROVIDER_BYPASS_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai sdk", pattern: /from\s+["']openai["']/ },
  { label: "anthropic sdk", pattern: /from\s+["']@anthropic-ai\// },
  { label: "openrouter provider import", pattern: /@quantum-l9\/llm-router\/openrouter/ },
  { label: "perplexity provider import", pattern: /@quantum-l9\/llm-router\/perplexity/ },
  { label: "openrouter endpoint", pattern: /openrouter\.ai/i },
  { label: "perplexity endpoint", pattern: /api\.perplexity\.ai/i },
  { label: "openai endpoint", pattern: /api\.openai\.com/i },
  { label: "anthropic endpoint", pattern: /api\.anthropic\.com/i },
];

describe("build-intelligence — no direct provider bypass", () => {
  it("has producer modules to inspect", () => {
    expect(producerFiles().length).toBeGreaterThan(0);
  });

  it("never reaches a provider SDK or endpoint directly", () => {
    const violations: string[] = [];
    for (const file of producerFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { label, pattern } of PROVIDER_BYPASS_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`PROVIDER_BYPASS_DETECTED: ${file} uses ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("routes every LLM call through the shared llm service", () => {
    for (const file of producerFiles()) {
      const source = readFileSync(file, "utf8");
      if (!/llm\.(execute|executePolicyJson|strategizeJson)/.test(source)) continue;
      expect(source, `${file} must import the shared llm service`).toMatch(
        /from\s+["']\.\.\/services\/llm\.js["']/,
      );
    }
  });
});

describe("CompetitiveLandscape — zero-LLM rank authority is structural", () => {
  const rankingModules = [
    "competitive-landscape.ts",
    "domain-classification.ts",
    "query-portfolio.ts",
  ];

  it("imports no LLM service anywhere on the ranking path", () => {
    for (const name of rankingModules) {
      const source = readFileSync(join(PRODUCER_DIR, name), "utf8");
      expect(source, `${name} must not import an LLM service`).not.toMatch(/services\/llm\.js/);
      expect(source, `${name} must not import the router`).not.toMatch(/@quantum-l9\/llm-router/);
    }
  });

  it("keeps deterministic claim grounding LLM-free as well", () => {
    const source = readFileSync(join(PRODUCER_DIR, "claim-grounding.ts"), "utf8");
    expect(source).not.toMatch(/services\/llm\.js/);
    expect(source).not.toMatch(/@quantum-l9\/llm-router/);
  });
});
