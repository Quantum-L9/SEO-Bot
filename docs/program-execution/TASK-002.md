# TASK-002 — Machine-auth contract for build intelligence

Campaign: `pe-seo-bot-build-intelligence-hardening-v2` · Stacked on TASK-001

## What changed

- `src/api/security.ts` — replaced the dual-acceptance auth hook with a
  strict least-privilege split:
  - `/api/build-intelligence/*` → **SEO_BOT_API_KEY only** (machine-auth
    surface; the operator key is deliberately rejected so the dashboard key
    never grants build-intelligence access);
  - other protected routes → **OPERATOR_API_KEY only** (dashboard/operator);
  - `/health` stays public; `/api/clients/register` keeps its own
    SEO_BOT_API_KEY machine handoff inside the route;
  - each surface fails closed (401) when its own key is unset.
  Header comment updated to match the security contract.
- `tests/api/security.test.ts` — added the strict-split matrix: operator key
  rejected on build-intelligence, invalid machine key 401, machine key
  unconfigured fails closed on build-intelligence (existing cases for
  machine-key acceptance and operator-route machine-key rejection remain).
- `tests/api/build-intelligence.test.ts` — build-intelligence route tests now
  authenticate with the machine credential (SEO_BOT_API_KEY) instead of the
  operator key, matching the new contract.

## Validation (run on the finished tree)

- `npm run typecheck` — PASS
- `npm test` — PASS (41 files, 377+ tests)
