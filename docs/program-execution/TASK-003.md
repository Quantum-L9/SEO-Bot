# TASK-003 — Authenticated build-intelligence preflight

Campaign: `pe-seo-bot-build-intelligence-hardening-v2` · Stacked on TASK-002

## What changed

- `src/api/build-intelligence.ts` — added `GET /api/build-intelligence/preflight`,
  machine-authenticated by the TASK-002 split (SEO_BOT_API_KEY only), making
  no LLM call and no DataForSEO paid call. Returns only non-secret readiness
  metadata: status, service, version (read from the service package.json),
  bot_interop_version and llm_router_version (read from the installed
  dependency package.jsons via a node_modules walk, since their exports maps
  do not expose package.json), capabilities (competitive_landscape,
  seo_content_blueprint, structured_content), and configuration
  (dataforseo_configured, llm_provider_configured derived from env presence
  only — never key values).
- `tests/api/build-intelligence.test.ts` — added preflight tests: 401 without
  credentials, readiness metadata shape with authenticated machine call, and
  a no-secrets assertion over the serialized payload.

## Validation (run on the finished tree)

- `npm run typecheck` — PASS
- `npm test` — PASS (41 files, 383 tests)
