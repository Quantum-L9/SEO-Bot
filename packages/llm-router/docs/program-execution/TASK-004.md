# TASK-004 — Required routing matrix regression tests

Campaign: `pe-router-capability-safety-v4` · Stacked on TASK-003

## What changed

- `tests/routing-matrix.test.ts` — completed the required routing matrix
  from the Website Contract: added the VISUAL_QA with **multiple** images
  case (row U) routing to vision with requiresSearch=false. Together with
  the rows landed in TASK-002, the matrix now covers every required row:
  STRATEGIC_REASONING with false → general and true → search;
  COMPETITOR_RESEARCH undefined → search and false → general;
  SCREENSHOT_ANALYSIS with image+false → vision, image+true → unsupported
  combination, no images → vision input required; CONTENT_GENERATION with
  images → unsupported combination; VISUAL_QA with multiple images+false →
  vision. All prior matrix rows stay green.

## Validation (run on the finished tree)

- `npm run verify:types` — PASS
- `npm test` — PASS
- `npm run lint` — PASS
