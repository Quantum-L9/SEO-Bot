# TASK-002 — Make StructuredContentPackage obey the exact block schema

Campaign: `seo-build-intelligence-29-route-producer-seam-v2`
Base SHA: `ffb87288a06b` (TASK-001 tip)

## Implemented

1. **Canonical prompt-side output contract** — `STRUCTURED_CONTENT_OUTPUT_CONTRACT`
   describes the exact block union (paragraph {kind,text}, bullets {kind,items},
   steps {kind,items}, quote {kind,text,attribution?}) plus metadata,
   cta, faqs, internal_links, and schema_content_inputs. It is included in
   every generation AND repair user prompt; Zod (`structuredContentRouteSchema`)
   stays the validation authority.
2. **Alias prohibition** — the generation system prompt now forbids
   content/body/copy/paragraphs/text aliases: all section prose must live
   inside `blocks`, each block must carry a supported `kind`, no fields beyond
   the contract. No `section.content → blocks` coercion was added — bad
   structure produces a schema failure, one repair, then a terminal failure.
3. **Nested-repair defect fixed** — `executePolicyJson` gained
   `schemaRepairAttempts?: 0 | 1` (default `?? 1` preserves existing callers);
   with 0 it validates the first response and returns — no embedded repair.
   `generateRoute` now passes `schemaRepairAttempts: 0` so StructuredContent
   owns the ONLY repair. Hard invariants hold: generation calls per route ≤ 2,
   repair attempts per route ≤ 1 (schema OR content repair, never both).
4. **Repair carries real failure evidence** — schema failures surface as
   `{ reason: "SCHEMA_FAILURE", validation_issues: [{path, message}] }` (zod
   issue paths preserved); content failures as
   `{ reason: "CONTENT_VALIDATION_FAILURE", failed_requirements, unsupported_claims }`.
   The repair prompt re-sends the exact output contract — never a bare
   "previous response was invalid, try again".
5. **Duplicate sections rejected** — `reconcileStructuredRoute` now throws on
   duplicate `section_id` in model output (new check). Current exact PCC
   lineage and route-order validation remain intact.

## Validation evidence

- `npx vitest run tests/build-intelligence/structured-content-block-schema.test.ts --reporter=basic` — PASS (17 tests)
- `npx vitest run tests/build-intelligence/structured-content.test.ts --reporter=basic` — PASS (unmodified)
- `npx vitest run tests/services/llm.test.ts --reporter=basic` — PASS (unmodified)
- `npx tsc -p tsconfig.check.json --noEmit` — PASS (exit 0)

Coverage matrix: content instead of blocks; missing blocks; blocks as string;
unknown block kind; paragraph without text; bullets/steps without items; quote
without text; missing/extra/duplicate section; wrong route/path (identity
re-asserted); first malformed → repair valid; first malformed → repair
malformed (terminal); semantic fail → repair valid; semantic fail → repair
fails (terminal); generation_calls ≤ 2 and repair_attempts ≤ 1 per route;
repair prompts carry SCHEMA_FAILURE / CONTENT_VALIDATION_FAILURE evidence.
