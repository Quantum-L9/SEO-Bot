/* L9_META
 * layer: test
 * role: test_fixture
 * status: active
 */

/**
 * Gives every test file its own on-disk root for the run-evidence store.
 *
 * Vitest runs test files in parallel workers that share one working
 * directory. The store persists failed-SERP refusals under its root, and
 * `_resetRunEvidenceStore()` deletes them. With one shared root, any file's
 * reset could delete another file's refusal in mid-test (seo-s9; the
 * competitive-landscape refusal test failed in CI that way). A private
 * temporary root per test file removes the shared state, so nothing is
 * skipped, serialized or retried. Production keeps `<cwd>/.l9/build-intelligence`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { _setRunEvidenceStateRootForTests } from "../../src/build-intelligence/run-evidence-store.js";

const root = mkdtempSync(path.join(tmpdir(), "seo-bot-run-evidence-"));
_setRunEvidenceStateRootForTests(root);

afterAll(() => {
  _setRunEvidenceStateRootForTests(undefined);
  rmSync(root, { recursive: true, force: true });
});
