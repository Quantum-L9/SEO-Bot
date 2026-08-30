# TASK-001 — Canonical capability resolver

Campaign: `pe-router-capability-safety` · Base SHA `14c7b83` · Branch `pec/w0/task-001`

## What changed

- `src/types.ts` — added `ResolvedCapabilities` (searchRequired, searchPolicySource,
  visionRequired) next to `SearchPolicyResolution`, so the resolver's output is a
  first-class shared type.
- `src/matrices/capabilities.ts` (new) — `VISION_TASKS` exported as the single
  authority for vision task types (VISUAL_QA, SCREENSHOT_ANALYSIS,
  LAYOUT_VALIDATION) and the canonical `resolveCapabilities(task)` resolver.
  Search truth delegates to `resolveSearchPolicy` — exactly one implementation of
  the search rule; `searchPolicySource` preserves the existing EXPLICIT /
  TASK_DEFAULT enum shape.
- `src/index.ts` — `resolveRoute` now consumes `resolveCapabilities` instead of
  re-deriving the search policy locally; the private `VISION_TASKS` constant was
  removed in favor of the exported one. The fail-closed search+vision guard and
  the dispatch behavior are unchanged.
- `tests/capabilities.test.ts` (new) — focused coverage: explicit true/false
  flags report EXPLICIT source, undefined flags report TASK_DEFAULT with the
  TaskType default, exactly the vision types are vision-required, and a vision
  task with an explicit search=false keeps both truths distinct.

## Validation (run on the finished tree)

- `npm run verify:types` — PASS (tsc --noEmit)
- `npm test` — PASS (23 files, 165 tests)
- `npm run lint` — PASS (eslint src/)

Existing search-policy tests and routing behavior are unchanged: the resolver
reuses `resolveSearchPolicy` and the same guard fires in the same cases.
