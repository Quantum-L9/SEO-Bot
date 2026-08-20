# TASK-004 — Bounded DataForSEO transient retry

Campaign: `pe-seo-bot-build-intelligence-hardening-v2` · Stacked on TASK-003

## What changed

- `src/services/dataforseo.ts` — the single-request client now retries at most
  once (MAX_DATAFORSEO_ATTEMPTS = 2: one initial attempt plus one retry):
  - retries only transient transport/provider conditions — HTTP 429, 502,
    503, 504, or connection-reset/establishment/timeout failures with no HTTP
    response;
  - never retries 4xx, invalid credentials, task-level DataForSEO errors,
    malformed provider results, or deterministic validation errors —
    task-level and evidence errors keep their distinct error classes exactly
    as before;
  - the delay honors Retry-After (seconds) capped at ~2 seconds, defaulting
    to ~500 ms;
  - every attempt is recorded (endpoint, attempt, status class, retry flag)
    via `providerAttempts` / `getProviderAttemptLog()` — never credentials or
    auth headers.
  The pure classification helpers (`isRetryableTransportFailure`,
  `failureClass`, `retryAfterDelayMs`) are exported for direct unit coverage.
- `src/build-intelligence/competitive-landscape.ts` — the evidence summary
  now carries `provider_attempts` so billable DataForSEO retries are visible
  in CompetitiveLandscape evidence.
- `tests/services/dataforseo.test.ts` — added the bounded-retry suite: one
  retry then success on 429, connection-reset retry, transient-status
  classification matrix (429/502/503/504 retry, 400/401/403 never), non-axios
  and deterministic failures never retry, Retry-After honoring and capping,
  and no-credentials telemetry. The existing serp-integrity suite keeps its
  provider-failure and no-empty-evidence guarantees.

## Validation (run on the finished tree)

- `npm run typecheck` — PASS
- `npm test` — PASS (41 files, 391 tests)
