import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWebsiteFactoryHandoffV3,
  buildSeoBotRegistrationAck,
  sealWebsiteFactoryHandoff,
  validateSeoBotRegistrationAck,
} from "../src/index.js";

const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);

function contract() {
  return sealWebsiteFactoryHandoff({
    protocol: "l9.website-factory.handoff",
    schema_version: "3.0",
    contract_id: "client:build:commit",
    emitted_at: new Date().toISOString(),
    client: { id: "client", domain: "example.com", name: "Example", industry: "services" },
    seo: { target_keywords: [{ keyword: "example", priority: "high" }], competitor_urls: [] },
    site: {
      repository: {
        provider: "github",
        full_name: "Quantum-L9/example",
        branch: "main",
        commit_sha: sha1,
        source_digest: sha256,
        managed_manifest_path: ".l9/generated-manifest.json",
        editable_root: "src/pages",
        page_path_strategy: "directory-index-astro",
      },
      deployment: {
        provider: "vercel",
        project_id: "p",
        deployment_id: "d",
        deployment_url: "https://example.com",
        state: "READY",
        requested_commit_sha: sha1,
        observed_commit_sha: sha1,
      },
      maintenance: {
        enabled: true,
        transport: "github-contents-api",
        github_credential_ref: "env://TOKEN",
        required_paths: [".l9/generated-manifest.json", "src/pages/index.astro"],
      },
    },
    proof: {
      receipt_id: "receipt",
      receipt_status: "succeeded",
      source_digest: sha256,
      dist_digest: "c".repeat(64),
      local_build_status: "passed",
      publication_status: "passed",
      deployment_status: "passed",
    },
  });
}

test("seals and validates the canonical handoff", () => {
  const value = contract();
  assert.doesNotThrow(() => assertWebsiteFactoryHandoffV3(value));
  assert.equal(value.integrity.payload_digest.length, 64);
});

test("builds the exact acknowledgement Website-Bot verifies", () => {
  const value = contract();
  const probes = ["credential", "repository", "branch_head", "managed_manifest"].map((name) => ({
    name,
    ok: true as const,
  }));
  const ack = buildSeoBotRegistrationAck(value, probes);
  assert.doesNotThrow(() => validateSeoBotRegistrationAck(ack));
  assert.equal(ack.contract_digest, value.integrity.payload_digest);
});

test("rejects duplicate required paths and incomplete proof", () => {
  const value = contract();
  const duplicate = structuredClone(value);
  duplicate.site.maintenance.required_paths.push(".l9/generated-manifest.json");
  assert.throws(() => assertWebsiteFactoryHandoffV3(duplicate), /uniquely include/);
  const incomplete = structuredClone(value);
  incomplete.proof.deployment_status = "failed" as "passed";
  assert.throws(() => assertWebsiteFactoryHandoffV3(incomplete), /proof is incomplete/);
});

test("rejects duplicate acknowledgement probes", () => {
  const value = contract();
  const probes = ["credential", "repository", "branch_head", "managed_manifest"].map((name) => ({
    name,
    ok: true as const,
  }));
  const ack = buildSeoBotRegistrationAck(value, probes);
  ack.probes[3] = { name: "credential", ok: true };
  assert.throws(() => validateSeoBotRegistrationAck(ack), /must be unique/);
});
