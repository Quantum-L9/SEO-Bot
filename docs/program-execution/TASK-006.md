# TASK-006 — StructuredContent schema contract + one-repair budget

Campaign: `pe-seo-bot-build-intelligence-hardening-v2` · Stacked on TASK-005

## What changed

- `src/build-intelligence/schema-guards.ts` — added
  `STRUCTURED_CONTENT_OUTPUT_CONTRACT`, a reusable generation-prompt contract
  adjacent to the runtime zod guard. It teaches the exact route shape
  (route_id, path, metadata, sections with section_id / optional eyebrow /
  heading / subheading / the blocks union of paragraph-with-text,
  bullets-with-items, steps-with-items, quote-with-text-and-optional-
  attribution, optional cta with label and action, faqs, internal_links,
  schema_content_inputs) and names the forbidden field aliases
  `content`, `body`, `copy`, `html`, `paragraphs` — section prose exists
  exclusively inside blocks. The zod schema remains final authority; the
  contract text exists so the model stops inventing `content: "..."`.
  Also added `schemaFailureDetails(error)` → `SchemaFailure[]`
  ({path, message} per zod issue; a single `$` entry otherwise) so repairs
  always receive exact, actionable evidence — never raw model output.
- `src/services/llm.ts` — `executePolicyJson` gains `schemaRepairAttempts`
  (0 or 1, default 1 so every pre-existing caller is unchanged) and an
  optional `callCounter` (`LlmCallCounter`, incremented once per ACTUAL
  router call). `0` opts out of the internal JSON/schema repair so the
  caller owns the one total repair — no hidden nested retry. Values other
  than 0 or 1 are rejected before any spend.
- `src/build-intelligence/structured-content.ts` — generation runs with
  `schemaRepairAttempts: 0`: each `generateRoute` is exactly ONE actual LLM
  call. The orchestrator now owns the ONE route repair, which covers a
  schema/parse failure OR a semantic failure (never both), so a route
  consumes at most two generation calls. The repair prompt carries exact
  failure evidence (`schema_failures` with path+message,
  `failed_requirements`, `unsupported_claims`) and the exact output
  contract again; a repaired output that fails full validation (parse +
  schema + deterministic + semantic) terminates the route with
  `CONTENT_REQUIREMENT_UNSATISFIED`. Generation and system prompts teach
  the blocks-union contract. No permissive content-to-blocks converter was
  added — bad model output stays visible and repairable, never silently
  normalized. Evidence is renamed and completed to count actual calls:
  `route_count`, `generation_llm_calls`, `semantic_validation_llm_calls`
  (counted through a wrapper that injects the shared counter into the
  semantic-validation call), `repair_attempts` (bounded at one per route,
  so at most `route_count`), `schema_failure_count`, `repaired_route_ids`.
- `tests/build-intelligence/structured-content.test.ts` — regression suite:
  content-alias-instead-of-blocks, missing blocks, blocks-as-string, unknown
  block kind, paragraph missing text, bullets missing items, quote missing
  text, malformed metadata, all-block-variants accepted, generation prompt
  teaches the union + forbidden aliases, first-malformed-then-repair-valid
  (with schema_failures evidence + contract again in the prompt),
  first-malformed-then-repair-malformed (terminal), schema-fail then
  semantic-fail staying within two generation calls (no hidden nested
  repair), repair_attempts ≤ route_count across two routes, and updated
  actual-call evidence assertions.
- `tests/services/llm.test.ts` — `executePolicyJson` suite: default one
  bounded repair, terminal second failure, `schemaRepairAttempts: 0`
  propagation with a single call, rejection of values other than 0|1 before
  spend, and callCounter increments (2 on repair, 1 with repair off even on
  failure).

## Validation (run on the finished tree)

- `npm run typecheck` — PASS
- `npm test` — PASS (41 files, 423 tests)
