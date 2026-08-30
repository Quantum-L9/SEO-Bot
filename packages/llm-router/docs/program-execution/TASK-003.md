# TASK-003 — Capability truth in RoutingDecision

Campaign: `pe-router-capability-safety-v4` · Stacked on TASK-002

## What changed

- `src/types.ts` — `RoutingResolution` gained `visionRequired: boolean`
  (documented), inherited by `RoutingDecision`, alongside the existing
  `searchRequired` and `searchPolicySource` audit fields from the merged
  search-policy work. The `SearchPolicySource` enum shape is unchanged.
- `src/index.ts` — `resolveRoute` populates `visionRequired` from the
  canonical `resolveCapabilities` output, so every decision reports the full
  capability truth without re-deriving it at the call site.
- `tests/routing-matrix.test.ts` — added a regression test asserting
  capability truth on every routing decision: a vision route reports
  `visionRequired: true` with `searchRequired: false` and EXPLICIT source
  (proving the SEO_CONTENT_BLUEPRINT-style audit shape without inferring
  policy from the model name), a general route reports `visionRequired:
  false`, and a search route reports `visionRequired: false` on Perplexity.

## Validation (run on the finished tree)

- `npm run verify:types` — PASS
- `npm test` — PASS
- `npm run lint` — PASS
