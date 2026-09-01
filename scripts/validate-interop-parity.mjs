// L9_META: layer=source, role=tracked_file, status=active, version=1.0.0
//
// WBV2-014: every vendored copy of bot-interop participating in the
// website-intelligence seam must be digest-identical for the canonical source
// set.
//
// Mechanism: both Website-Bot and SEO-Bot commit the SAME
// contracts/BOT_INTEROP_PARITY.json, and each validates its own vendored
// sources against it. Two repos that both pass are thereby proven identical to
// each other, with no network access and no cross-repo checkout — so this runs
// in ordinary CI on either side and fails on drift introduced by either.
//
//   node scripts/validate-interop-parity.mjs           # verify (CI)
//   node scripts/validate-interop-parity.mjs --write   # regenerate after an
//                                                      # intentional contract
//                                                      # change (then copy the
//                                                      # manifest to the peer)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC_DIR = resolve("packages/bot-interop/src");
const MANIFEST_PATH = resolve("contracts/BOT_INTEROP_PARITY.json");
const PEERS = ["Quantum-L9/Website-Bot", "Quantum-L9/SEO-Bot"];

function canonicalSourceSet() {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function digestOf(name) {
  return createHash("sha256").update(readFileSync(resolve(SRC_DIR, name))).digest("hex");
}

const files = Object.fromEntries(canonicalSourceSet().map((name) => [name, digestOf(name)]));
/** One digest over the whole set, so a single value identifies the contract. */
const setDigest = createHash("sha256")
  .update(JSON.stringify(files))
  .digest("hex");

if (process.argv.includes("--write")) {
  const manifest = {
    invariant: "WBV2-014",
    note:
      "Canonical bot-interop source set. Every repo in the website-intelligence " +
      "seam commits this identical manifest and validates its vendored copy " +
      "against it. Regenerate with --write, then copy this file to every peer.",
    peers: PEERS,
    canonical_source_set: "packages/bot-interop/src/*.ts",
    algorithm: "sha256",
    set_digest: setDigest,
    files,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, wrote: MANIFEST_PATH, set_digest: setDigest })}\n`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  console.error(`WBV2-014 VIOLATION: cannot read ${MANIFEST_PATH}: ${String(error)}`);
  process.exit(1);
}

const problems = [];
const expected = manifest.files ?? {};
for (const [name, digest] of Object.entries(expected)) {
  if (!(name in files)) {
    problems.push(`MISSING  ${name} — manifest expects it, this repo does not ship it`);
  } else if (files[name] !== digest) {
    problems.push(`DRIFT    ${name}\n           expected ${digest}\n           observed ${files[name]}`);
  }
}
for (const name of Object.keys(files)) {
  if (!(name in expected)) {
    problems.push(`EXTRA    ${name} — present here but absent from the shared manifest`);
  }
}
if (manifest.set_digest !== setDigest && problems.length === 0) {
  problems.push(
    `SET_DIGEST expected ${manifest.set_digest}, observed ${setDigest} — regenerate the manifest`,
  );
}

if (problems.length > 0) {
  console.error("WBV2-014 VIOLATION: vendored bot-interop has drifted from the shared contract.\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\nThe canonical source set must stay byte-identical across ${PEERS.join(" and ")}. ` +
      "Port the change to every peer, regenerate with --write, and commit the same " +
      "manifest in each repo.",
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    invariant: "WBV2-014",
    set_digest: setDigest,
    files: Object.keys(files).length,
    peers: manifest.peers ?? PEERS,
  })}\n`,
);
