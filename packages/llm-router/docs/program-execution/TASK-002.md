# TASK-002 — Fail unsupported capability combinations

Campaign: `pe-router-capability-safety-v4` · Stacked on TASK-001

## What changed

- `src/matrices/capabilities.ts` — added `VisionInputRequiredError`
  (code `VISION_INPUT_REQUIRED`) and `assertSupportedCapabilities(task,
  capabilities)`, which refuses before any reservation, circuit permit, or
  provider dispatch:
  - visionRequired + searchRequired → `UNSUPPORTED_CAPABILITY_COMBINATION`
    (no provider serves search and vision together);
  - images on a non-vision task type → `UNSUPPORTED_CAPABILITY_COMBINATION`
    (images are only consumed by the vision branch);
  - a vision task with no images → `VISION_INPUT_REQUIRED`.
- `src/index.ts` — `resolveRoute` now calls `assertSupportedCapabilities`
  instead of the narrower images-present guard; `dispatchProvider` gained the
  vision dispatch invariant (a vision task must dispatch on the OpenRouter
  vision plane, never Perplexity or the general path).
- `tests/routing-matrix.test.ts` — matrix rows added: screenshot analysis
  without images fails closed, content generation with images fails closed,
  visual QA with images routes to vision; FAIL_CLOSED assertions now check the
  failure code (`UNSUPPORTED_CAPABILITY_COMBINATION` or
  `VISION_INPUT_REQUIRED`).
- `tests/search-policy-dispatch.test.ts` — updated the two legacy cases the
  contract supersedes: a visual task with no images is now refused
  (`VISION_INPUT_REQUIRED`) instead of routing with a defaulted image count,
  and a visual task with no images plus explicit search is now an
  `UNSUPPORTED_CAPABILITY_COMBINATION` instead of a plain search request; the
  image-count regression guard now asserts the no-image refusal explicitly.

## Validation (run on the finished tree)

- `npm run verify:types` — PASS
- `npm test` — PASS (23 files, 169 tests)
- `npm run lint` — PASS
