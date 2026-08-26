# TASK-007 — SEOContentBlueprint measured run evidence

Campaign: `seo-build-intelligence-29-route-producer-seam-v2`

## Context

The 29-route producer seam (compact global route intent plan → deterministic
4-route batches → batch-scoped reconciliation → deterministic whole-site merge)
landed on `main` in the `pe-seo-bot-build-intelligence-hardening-v2` campaign
(TASK-001..006). This task carries the one part of the seam campaign that
`main` does not already have: the evidence sibling for the blueprint producer.

## What changed

- `src/build-intelligence/seo-content-blueprint.ts`
  - `SEOContentBlueprintEvidence` / `SEOContentBlueprintResult` and
    `createSEOContentBlueprintWithEvidence`, the blueprint counterpart of the
    `createStructuredContentPackageWithEvidence` sibling already established in
    `structured-content.ts`. `createSEOContentBlueprint` is now a thin delegate
    and its return value is unchanged, so every existing caller
    (`src/api/build-intelligence.ts`, `scripts/build-intelligence/producer-seam-proof.ts`)
    is unaffected.
  - Every evidence counter is COUNTED from the actual run — phase-A call,
    per-batch calls, completed batches — never inferred. A batch that fails its
    bounded repair still fails the whole artifact, so a partial run never seals
    and never reports completed batches.
  - `SEO_BLUEPRINT_BATCH_SIZE` and `chunkRoutes()` are exported so the batch
    split is assertable from tests rather than re-derived in them.
- `src/build-intelligence/schema-guards.ts`
  - `globalRouteIntentRouteSchema` + `GlobalRouteIntentRoute` moved here, next
    to every other runtime zod guard for model output. The producer imports it
    instead of carrying a second inline copy — one authority for the shape.

## Validation

- `npx vitest run tests/build-intelligence/seo-content-blueprint.test.ts` — the
  existing suite is unmodified and green, plus new cases for the batch split
  (order, short final chunk, empty set, default size) and the evidence counters
  across 1 / 4 / 5 / 8 / 29 / 40 routes, delegate parity, and the fail-closed
  path.
- `npx tsc -p tsconfig.check.json --noEmit`
- `npx vitest run`
