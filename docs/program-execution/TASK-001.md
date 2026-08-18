# TASK-001 — Make SEOContentBlueprint batch-safe at 29+ routes

Campaign: `seo-build-intelligence-29-route-producer-seam-v2`
Base SHA: `cfb3d3691b270f726ab8d6b75dafdcf9fae1682b`

## Implemented

1. **Compact internal global plan** — `globalRouteIntentSchema` (strict zod:
   `route_id`, `primary_query`, `primary_intent`, `journey_stage` enum of
   informational/commercial/transactional) added in `schema-guards.ts`;
   internal only, no cross-repo artifact. The global planning call returns
   ONLY this intent summary; parity is validated deterministically (no
   missing, no extra, no duplicate route ID, requested order).
2. **Deterministic batches** — `SEO_BLUEPRINT_BATCH_SIZE = 4` and
   `chunkRoutes<T>()`; batch composition strictly from `request.routes`
   order, never model output. Safe Haven: 29 routes → 8 batches
   (4+4+4+4+4+4+4+1). Single-batch route sets (≤ 4 routes) skip the global
   plan call — one strategic call covers the whole site.
3. **Global site awareness per batch** — every batch prompt carries
   `all_routes` (MAY be referenced for internal links),
   `current_batch_routes` (MUST be returned), `global_route_strategy`,
   `market`, `query_portfolio`, `selected_donors`, `normalized_donor_evidence`,
   `verified_business_facts`, and `seo_config`.
4. **Batch-scoped reconciliation** — `reconcileBatchRoutes(value,
   batchRoutes, allRouteIds)`: rejects routes from other batches
   (`SeoContentBlueprintInvalidError`), throws on missing requested routes,
   re-asserts route identity from the request, and runs
   `assertBlueprintSemantics` against `allRouteIds` (cross-batch internal
   links validate: a batch-3 route may link to batch-8).
5. **Deterministic whole-site merge** — `mergeBatchResults` orders strictly
   by `request.routes`, rejects duplicate and missing generated routes, then
   the existing whole-site semantic checks run again before
   `SEOContentBlueprintV1` is sealed.
6. **Measured evidence** — `SEOContentBlueprintEvidence` (route_count,
   batch_size, batch_count, completed_batches, missing_route_ids,
   extra_route_ids) and sibling `createSEOContentBlueprintWithEvidence`;
   the normal endpoint still returns only the artifact.

Slot vocabulary and route-schema validation (`seoContentBlueprintRoutesSchema`)
remain authoritative and unchanged.

## Validation evidence

- `npx vitest run tests/build-intelligence/seo-content-blueprint-batch.test.ts --reporter=basic` — PASS (17 tests)
- `npx vitest run tests/build-intelligence/seo-content-blueprint.test.ts --reporter=basic` — PASS (19 tests, unmodified)
- `npx tsc -p tsconfig.check.json --noEmit` — PASS (exit 0)

Coverage matrix: 1 / 4 / 5 / 8 / 29 / 40 routes; batch misses a route (repair
once → success, twice → terminal); batch adds a route from another batch
(rejected, repair path covered); cross-batch internal link valid; unknown
internal-link target invalid; global plan parity (missing / extra / duplicate
→ terminal after the single repair); 29 requested → exactly 29 produced in
original request order.
