# TASK-005 — Two-phase full-site SEO blueprint batching

Campaign: `pe-seo-bot-build-intelligence-hardening-v2` · Stacked on TASK-004

## What changed

`src/build-intelligence/seo-content-blueprint.ts` — the producer no longer
puts the entire route set into one prompt. It now runs in two phases while
still sealing ONE SEOContentBlueprint artifact:

- **Phase A — global route intent plan.** One compact `strategizeJson` call
  produces `GlobalRouteIntent` entries for ALL routes (route_id,
  primary_query, primary_intent, journey_stage). The validator requires the
  exact route count, the exact route IDs, and no duplicate normalized
  primary_query. This internal object is never exposed as a public
  cross-repo artifact.
- **Phase B — deterministic batches.** Routes are split into hard
  deterministic batches of `SEO_BLUEPRINT_BATCH_SIZE = 4` (the LLM never
  chooses batching). Every batch prompt carries the market, query portfolio,
  selected donors, normalized donor evidence, the all-route index
  (route_id/path/purpose), the global route intent plan, only the current
  batch's full route records, business facts, SEO config, and the output
  contract.
- **Split reconciliation authorities** (`reconcileBatch`): output route IDs
  must equal the batch route IDs exactly; internal-link targets must belong
  to the all-route ID set (cross-batch links are valid); route identity is
  re-asserted from the request; primary_query and top-level intent are
  re-asserted from the global intent plan — the model cannot silently change
  the global strategy in a later batch.
- **Deterministic merge + whole-site validator**: batches merge in requested
  order; `assertWholeSiteBlueprint` enforces same count, exact order and
  paths, no duplicate route IDs, no unknown link targets, no self-links, no
  duplicate requirement IDs, all target slots valid, and no duplicate
  primary queries before the single artifact is sealed.
- **Failure semantics**: a batch that fails its one bounded repair raises
  `SEO_CONTENT_BLUEPRINT_BATCH_INVALID` (code) and the whole artifact fails —
  a partial route set (e.g. 28/29) is never sealed as success.

`tests/build-intelligence/seo-content-blueprint.test.ts` — regression suite
added: 1, 4, 5, 8, 29, and 40 route counts with exact coverage and expected
batch counts; batch missing a route; batch returning another batch's route;
cross-batch internal link; unknown internal-link target; duplicate primary
query in the global plan; batch repair failure; and the never-seal-partial
(28/29) case. Existing tests updated for the two-phase protocol (phase A
plus deterministic batches).

## Validation (run on the finished tree)

- `npm run typecheck` — PASS
- `npm test` — PASS (41 files, 403 tests)
