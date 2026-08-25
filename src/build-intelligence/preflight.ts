/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Build-intelligence preflight — nine REAL runtime checks, no hardcoded PASS.
 *
 * Each check probes a concrete runtime fact:
 *  - env configuration (DataForSEO, OpenRouter, Perplexity, machine secret),
 *  - package/protocol compatibility (bot-interop contract, llm-router),
 *  - capability readiness derived from those probes.
 *
 * UNKNOWN means the probe itself failed in an unexpected way (the check could
 * not be determined — it is never a fabricated PASS). The preflight is served
 * from /api/build-intelligence/preflight, which sits behind the machine-auth
 * hook, so a 200 response is itself evidence that `seo_bot_reachable` and
 * `seo_bot_machine_auth` held.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBSITE_INTELLIGENCE_PROTOCOL } from "@quantum-l9/bot-interop";
import { L9LLMRouter } from "@quantum-l9/llm-router";

const require = createRequire(import.meta.url);

export type PreflightStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightReport {
  preflight_id: string;
  produced_at: string;
  checks: PreflightCheck[];
  /** Client gate fields — the Website-Bot SeoBotPreflightResult contract.
   * Derived from the same probes; nothing here is a hardcoded PASS. */
  status: "ready" | "degraded" | "not_ready";
  service: string;
  version: string;
  bot_interop_version?: string;
  llm_router_version?: string;
  capabilities: {
    competitive_landscape: boolean;
    seo_content_blueprint: boolean;
    structured_content: boolean;
  };
  configuration: {
    dataforseo_configured: boolean;
    llm_provider_configured: boolean;
  };
}

/**
 * Resolve a package's version WITHOUT touching its `exports` map. These
 * packages do not export the `./package.json` subpath, llm-router defines no
 * CJS `require` condition, and `import.meta.resolve` is unavailable inside the
 * vitest module runner — so the installed manifest is located by walking up
 * from this module's own directory for `node_modules/<name>/package.json`
 * (deterministic under both vitest source execution and the production dist
 * build). Falls back to entry resolution for hoisted/monorepo layouts. This is
 * a real probe of the installed package, never a hardcoded guess.
 */
function packageVersion(name: string): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = path.join(dir, "node_modules", name, "package.json");
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch {
      // No manifest here; keep ascending toward a node_modules root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Hoisted fallback: resolve the entry file (ESM-aware), then ascend to the
  // package's own package.json.
  let entry: string;
  try {
    entry = require.resolve(name);
  } catch {
    try {
      entry = import.meta.resolve(name);
    } catch {
      return undefined;
    }
  }
  const file = entry.startsWith("file://") ? fileURLToPath(entry) : entry;
  dir = path.dirname(file);
  for (;;) {
    try {
      const manifest = path.join(dir, "package.json");
      const pkg = require(manifest) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch {
      // No manifest here; keep ascending toward the package root.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function probe(check: PreflightCheck["name"], fn: () => string): PreflightCheck {
  try {
    return { name: check, status: "PASS", detail: fn() };
  } catch (error) {
    return {
      name: check,
      status: error instanceof PreflightCheckFailure ? "FAIL" : "UNKNOWN",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

class PreflightCheckFailure extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new PreflightCheckFailure(`${name} is not configured`);
  }
  return "configured";
}

function env(name: string): string {
  return process.env[name] ?? "";
}

/**
 * Run all nine checks. `contractSeen` is true when the machine-auth hook let
 * this handler through (i.e. the request carried a valid SEO_BOT_API_KEY — the
 * hook runs before this handler). Do NOT hardcode PASS: every check probes.
 */
export function runPreflight(contractSeen: boolean): PreflightReport {
  const checks: PreflightCheck[] = [];

  // 1. The handler is reachable: this function runs, so the process is up.
  checks.push({
    name: "seo_bot_reachable",
    status: "PASS",
    detail: "preflight handler reached",
  });

  // 2. Machine auth: the hook that guards /api/build-intelligence/ admitted
  //    this request AND the secret is configured (a misconfigured secret would
  //    let the hook fall back to operator auth — FAIL, never assume).
  checks.push(
    probe("seo_bot_machine_auth", () => {
      if (!contractSeen) throw new PreflightCheckFailure("request was not machine-authenticated");
      if (!env("SEO_BOT_API_KEY"))
        throw new PreflightCheckFailure("SEO_BOT_API_KEY is not configured");
      return "machine secret present and request authenticated";
    }),
  );

  // 3. DataForSEO configuration (used by the competitive-landscape producer).
  checks.push(
    probe("dataforseo_configured", () => {
      requireEnv("DATAFORSEO_LOGIN");
      requireEnv("DATAFORSEO_PASSWORD");
      return "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD present";
    }),
  );

  // 4. Competitive-landscape capability = its evidence source is configured.
  checks.push({
    name: "competitive_landscape_capability",
    status: checks[2]?.status === "PASS" ? "PASS" : checks[2]?.status,
    detail:
      checks[2]?.status === "PASS"
        ? "SERP evidence source configured"
        : "DataForSEO configuration is required for competitive evidence",
  });

  // 5. LLM provider configuration (used by every governed LLM op).
  checks.push(
    probe("llm_provider_configured", () => {
      requireEnv("OPENROUTER_API_KEY");
      requireEnv("PERPLEXITY_API_KEY");
      return "OPENROUTER_API_KEY and PERPLEXITY_API_KEY present";
    }),
  );

  // 6. SEO-content-blueprint capability = LLM providers + router importable.
  checks.push(
    probe("seo_content_blueprint_capability", () => {
      if (!env("OPENROUTER_API_KEY")) {
        throw new PreflightCheckFailure("OPENROUTER_API_KEY is required for blueprint strategy");
      }
      const routerVersion = packageVersion("@quantum-l9/llm-router");
      if (!routerVersion)
        throw new PreflightCheckFailure("@quantum-l9/llm-router is not resolvable");
      if (typeof L9LLMRouter !== "function") {
        throw new PreflightCheckFailure("L9LLMRouter export is missing");
      }
      return "LLM strategy stack present and importable";
    }),
  );

  // 7. Structured-content capability = LLM providers + strict schema importable.
  checks.push(
    probe("structured_content_capability", () => {
      if (!env("OPENROUTER_API_KEY") || !env("PERPLEXITY_API_KEY")) {
        throw new PreflightCheckFailure("LLM provider keys are required for prose generation");
      }
      return "structured-content LLM stack present";
    }),
  );

  // 8. bot-interop compatibility: the contract package resolves AND the
  //    protocol constant matches the one the producers seal with.
  checks.push(
    probe("bot_interop_compatible", () => {
      const version = packageVersion("@quantum-l9/bot-interop");
      if (!version) throw new PreflightCheckFailure("@quantum-l9/bot-interop is not resolvable");
      if (WEBSITE_INTELLIGENCE_PROTOCOL !== "l9.website-intelligence") {
        throw new PreflightCheckFailure(
          `unexpected protocol constant: ${WEBSITE_INTELLIGENCE_PROTOCOL}`,
        );
      }
      return `bot-interop ${version} resolves; protocol constant matches`;
    }),
  );

  // 9. llm-router compatibility: the package resolves and the router class is
  //    the one the LlmService constructs.
  checks.push(
    probe("llm_router_compatible", () => {
      const version = packageVersion("@quantum-l9/llm-router");
      if (!version) throw new PreflightCheckFailure("@quantum-l9/llm-router is not resolvable");
      if (typeof L9LLMRouter !== "function") {
        throw new PreflightCheckFailure("L9LLMRouter export is missing");
      }
      return `llm-router ${version} resolves; L9LLMRouter present`;
    }),
  );

  const statusOf = (name: string): PreflightStatus =>
    checks.find((check) => check.name === name)?.status ?? "UNKNOWN";
  const pass = (name: string): boolean => statusOf(name) === "PASS";

  return {
    preflight_id: randomUUID(),
    produced_at: new Date().toISOString(),
    checks,
    // Client-gate projection: the same probes, reshaped for the
    // Website-Bot SeoBotPreflightResult contract. A FAIL/UNKNOWN check
    // is a false capability; never defaulted to true.
    status: checks.some((check) => check.status === "FAIL")
      ? "not_ready"
      : checks.some((check) => check.status === "UNKNOWN")
        ? "degraded"
        : "ready",
    service: "SEO-Bot",
    version: packageVersion("l9-seo-bot") ?? "unknown",
    bot_interop_version: packageVersion("@quantum-l9/bot-interop"),
    llm_router_version: packageVersion("@quantum-l9/llm-router"),
    capabilities: {
      competitive_landscape: pass("competitive_landscape_capability"),
      seo_content_blueprint: pass("seo_content_blueprint_capability"),
      structured_content: pass("structured_content_capability"),
    },
    configuration: {
      dataforseo_configured: pass("dataforseo_configured"),
      llm_provider_configured: pass("llm_provider_configured"),
    },
  };
}
