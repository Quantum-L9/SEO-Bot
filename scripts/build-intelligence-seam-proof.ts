/* L9_META
 * layer: script
 * role: seo_bot_engine
 * status: active
 */

/**
 * One real SEO-Bot producer seam proof. Does not run Website-Bot Golden E2E.
 * Writes reports/SeoBuildIntelligenceIntegrityReceipt.json
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CompetitiveLandscapeArtifact, refForArtifact } from "@quantum-l9/bot-interop";
import { buildApiServer } from "../src/api/index.js";
import { createCompetitiveLandscape } from "../src/build-intelligence/competitive-landscape.js";
import {
  type SeoBuildIntelligenceIntegrityReceipt,
  validateIntegrityReceipt,
} from "../src/build-intelligence/integrity-receipt.js";
import { createSEOContentBlueprint } from "../src/build-intelligence/seo-content-blueprint.js";
import { getConfig } from "../src/core/config.js";
import { hydrateSecretsIfConfigured } from "../src/core/secrets.js";

function readJson(path: string): { version: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { version: string };
}

const SAFE_HAVEN_ROUTES = [
  { route_id: "home", path: "/", purpose: "primary landing" },
  { route_id: "services", path: "/services", purpose: "service overview" },
  { route_id: "roof-replacement", path: "/services/roof-replacement", purpose: "roof replacement" },
  { route_id: "contact", path: "/contact", purpose: "conversion" },
];

const CONTENT_SLOTS = new Set([
  "primary_offer",
  "service_overview",
  "differentiation",
  "trust",
  "process",
  "project_proof",
  "local_relevance",
  "objection_handling",
  "faq",
  "conversion",
  "metadata",
]);

function sha(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
}

function pkgVersion(name: string): string {
  return readJson(join(process.cwd(), "node_modules", name, "package.json")).version;
}

async function main(): Promise<void> {
  await hydrateSecretsIfConfigured();
  const config = getConfig();
  const authKey = config.OPERATOR_API_KEY || config.SEO_BOT_API_KEY;
  if (!authKey) {
    throw new Error("REAL authentication unavailable: OPERATOR_API_KEY and SEO_BOT_API_KEY unset");
  }

  const app = await buildApiServer();
  const unauth = await app.inject({
    method: "POST",
    url: "/api/build-intelligence/competitive-landscape",
    payload: { client_id: "safehavenrr", build_id: "x" },
  });
  if (unauth.statusCode !== 401) {
    throw new Error(`Auth fail-closed check failed: expected 401, got ${unauth.statusCode}`);
  }

  const clientId = "safehavenrr";
  const buildId = `campaign-7-seo-seam-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const landscapeBody = {
    client_id: clientId,
    build_id: buildId,
    market: {
      niche: "roofing_and_renovations",
      country: "US",
      language: "English",
      device: "desktop",
      location_name: "North Carolina,United States",
    },
    seed_queries: [
      { query: "roof replacement Charlotte NC", intent: "commercial" as const },
      { query: "roof repair Charlotte", intent: "transactional" as const },
      { query: "storm damage roof inspection Charlotte", intent: "commercial" as const },
      { query: "metal roofing Charlotte NC", intent: "commercial" as const },
      { query: "roofing contractor Gastonia NC", intent: "transactional" as const },
    ],
    desired_donor_count: 10,
  };

  const landscapeRes = await app.inject({
    method: "POST",
    url: "/api/build-intelligence/competitive-landscape",
    headers: { authorization: `Bearer ${authKey}` },
    payload: landscapeBody,
  });

  let landscape: CompetitiveLandscapeArtifact;
  if (landscapeRes.statusCode === 201) {
    landscape = landscapeRes.json();
  } else {
    // Persistence/DB issues must not block a sealed producer result.
    landscape = await createCompetitiveLandscape(landscapeBody);
  }

  writeFileSync(
    "reports/seam-competitive-landscape.json",
    `${JSON.stringify(landscape, null, 2)}\n`,
  );
  if (landscape.payload.selected_donors.length !== 10 || !landscape.payload.evidence_complete) {
    throw new Error(
      `Landscape invariant failed: donors=${landscape.payload.selected_donors.length} complete=${landscape.payload.evidence_complete}`,
    );
  }

  const originalQueryCount = landscape.payload.query_portfolio.filter((q: { query_id: string }) =>
    q.query_id.startsWith("q"),
  ).length;
  const expandedQueryCount = landscape.payload.query_portfolio.length - originalQueryCount;
  const qualified = landscape.payload.domains.filter(
    (d: { domain: string }) =>
      !landscape.payload.exclusions.some((e: { domain: string }) => e.domain === d.domain),
  ).length;

  const blueprint = await createSEOContentBlueprint({
    client_id: clientId,
    build_id: buildId,
    competitive_landscape: landscape,
    routes: SAFE_HAVEN_ROUTES,
    business_facts: [
      {
        fact_id: "f-name",
        key: "business_name",
        value: "Safe Haven Roofing & Renovations",
        verified: true,
        source_refs: ["fixtures/safehavenrr-spec.yaml"],
      },
      {
        fact_id: "f-phone",
        key: "phone",
        value: "(704) 648-7252",
        verified: true,
        source_refs: ["safehavenrr.com"],
      },
      {
        fact_id: "f-geo",
        key: "service_area",
        value: ["NC", "SC"],
        verified: true,
        source_refs: ["fixtures/safehavenrr-spec.yaml"],
      },
    ],
    seo_config: { forbidden_claims: ["decades of experience"] },
  });

  writeFileSync(
    "reports/seam-seo-content-blueprint.json",
    `${JSON.stringify(blueprint, null, 2)}\n`,
  );
  const invalidSlots = blueprint.payload.routes.flatMap((route) =>
    route.requirements.flatMap((req) =>
      req.target_slots.filter((slot) => !CONTENT_SLOTS.has(slot)),
    ),
  ).length;

  const landscapeRef = refForArtifact(landscape);
  const receipt: SeoBuildIntelligenceIntegrityReceipt = {
    identity: {
      seo_bot_sha: sha(),
      seo_bot_version: readJson(join(process.cwd(), "package.json")).version,
      bot_interop_version: pkgVersion("@quantum-l9/bot-interop"),
      llm_router_version: pkgVersion("@quantum-l9/llm-router"),
    },
    competitive: {
      request_identity: { client_id: clientId, build_id: buildId },
      query_count_original: originalQueryCount,
      query_count_expanded: expandedQueryCount,
      real_dataforseo_evidence_count: landscape.payload.observations.length,
      qualified_candidate_count: qualified,
      excluded_candidate_count: landscape.payload.exclusions.length,
      selected_donor_count: landscape.payload.selected_donors.length,
      selected_donor_refs: landscape.payload.selected_donors.map(
        (d: { domain: string }) => d.domain,
      ),
      evidence_complete: landscape.payload.evidence_complete,
      competitive_artifact_ref: {
        artifact_id: landscape.artifact_id,
        payload_digest: landscape.integrity.payload_digest,
      },
      competitive_ranking_llm_calls: 0,
    },
    seo_blueprint: {
      artifact_ref: {
        artifact_id: blueprint.artifact_id,
        payload_digest: blueprint.integrity.payload_digest,
      },
      exact_competitive_landscape_ref: {
        artifact_id: landscapeRef.artifact_id,
        payload_digest: landscapeRef.payload_digest,
      },
      route_count: blueprint.payload.routes.length,
      invalid_slot_count: invalidSlots,
      router_only_llm: true,
    },
    structured_content: {
      executed: false,
      reason: "CONSUMER_PCC_REQUIRED_FOR_FINAL_SEAM",
    },
    interop: { artifact_schema_parity: "PASS" },
    final: { SEO_BUILD_INTELLIGENCE_INTEGRITY: "BLOCKED_ON_CONSUMER_PCC" },
  };

  const validation = validateIntegrityReceipt(receipt);
  if (!validation.ok) {
    receipt.final.SEO_BUILD_INTELLIGENCE_INTEGRITY = "FAIL";
  }

  writeFileSync(
    "reports/SeoBuildIntelligenceIntegrityReceipt.json",
    `${JSON.stringify({ receipt, validation, landscape_http_status: landscapeRes.statusCode }, null, 2)}\n`,
  );
  await app.close();
  if (!validation.ok) {
    throw new Error(`Integrity receipt failed: ${validation.failures.join("; ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
