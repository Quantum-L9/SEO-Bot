# AGENTS.md — L9 SEO Bot operating contract

Binding control plane for AI agents in this repo. Compact by design; load it every session.
Every rule here changes behavior. When this file disagrees with the code, **the code wins** (see
Authority order) — fix the stale rule.

## 1. Identity

- **What:** `l9-seo-bot` v2.0.0 — a multi-tenant SEO **maintenance daemon**. One long-running
  Node/TS process: Fastify REST API + BullMQ workers, managing SEO for many client sites, every
  row/query/job scoped by `clientId`. Deterministic-first (≈95% zero-token code; LLM only for judgment).
- **Archetype:** deployable service, **not** a library or published package. No consumer API stability
  contract beyond the webhook schema in §4.
- **Stack (locked):** Node `>=22`, TypeScript strict, **ESM** (`"type":"module"`), **npm**,
  **no lockfile**. BullMQ + Redis, Drizzle + Postgres, self-hosted PostHog, Pino logs.
  LLM via `@quantum-l9/llm-router` (private GitHub Packages, `@quantum-l9` scope).

## 2. Operating mode — default to action

- Reversible, evidence-supported next step → **do it, then report.** No permission theater, no menus.
- State a low-risk assumption once and proceed; validate by tsc/vitest/git-diff.
- **Stop and ask only when** an action is destructive/irreversible, force-pushes over others, touches
  secrets/production, enables the gated site-deploy path (§9), or needs authority/credentials you lack.
- **`l4` (optional session token):** if the operator says `l4`, stop asking low-risk clarifying
  questions this session — choose sane reversible defaults, execute through validation, report what you
  did. `l4` never authorizes destructive, irreversible, credential, production, publication, or
  force-overwrite actions; §9 still binds.
- Never claim a remote action (push/PR/merge) or a credential-bound check passed without observed evidence.

## 3. Authority order (higher wins; record conflicts)

1. Explicit operator instruction.
2. **Executable truth** — CI (`.github/workflows/ci.yml`), tests, `src/core/config.ts`, `package.json`.
3. Contracts & ADRs — `contracts/website_factory_integration.yaml`, `src/contracts/*`, `adr/`.
4. This file.
5. Other docs (README, CONTRIBUTING, MANIFEST, RUNBOOK).

Executable truth beats prose. Some docs are known-stale: **CONTRIBUTING/README say `pnpm` — wrong,
this repo is npm**; **MANIFEST.md is incomplete** (missing several `src/` files); `npm run seed`
points at a `seed.ts` that does not exist. Follow the code; don't propagate the stale prose.

## 4. Navigation — canonical sources of truth

- **Start:** `src/index.ts` (entry) → `src/core/` (config, scheduler, logger, secrets, database) →
  `src/modules/*` (the 5 job-handler pillars) → `src/services/*` → `src/api/*`.
- **Env/config:** `src/core/config.ts` (Zod `envSchema`, `getConfig()`) is the only config gateway;
  `.env.example` is the template. Secrets hydrate first via `src/core/secrets.ts` (Infisical).
- **DB schema:** `src/core/database/schema.ts` + `schema-extensions.ts` (Drizzle). `drizzle.config.ts`
  lists both.
- **Webhook contract:** `contracts/website_factory_integration.yaml` + validator
  `src/contracts/website_factory_v2.ts` (`schema_version` literal `'2.0'`). PostHog event names:
  `src/contracts/posthog_events.ts`.
- **Decisions:** `adr/` (ADR-0001..0006, all accepted) + `adr/README.md`; `DECISION_LOG.md`.
- **Do-not-edit / generated:** `drizzle/` migrations + `drizzle/meta/` (regenerate, never hand-edit),
  `dist/` (build output, gitignored), `validation/*.jsonl` (machine evidence).

## 5. Execution — verified commands

| Purpose | Command | Notes |
|---|---|---|
| Install | `npm install --no-audit --no-fund` | No lockfile — never `npm ci`. Needs `NODE_AUTH_TOKEN` for `@quantum-l9/*`. |
| Build | `npm run build` | `tsc` → `dist/` |
| Typecheck | `npx tsc --noEmit` | **Blocking CI gate.** `strict:true`. |
| Test | `npx vitest run` | **Blocking CI gate.** Vitest; `NODE_ENV=test`. |
| Preflight | `npm run verify:all` | preflight+source+build only — **not** typecheck/tests. A smoke check, not the gate. |
| DB migrate | `npm run migrate` / `verify:db` (`--check`) | Mutates the DB — treat as stateful (§9). |
| Dev | `npm run dev` | `tsx watch` |

- **Private-dep auth:** installing `@quantum-l9/*` needs `NODE_AUTH_TOKEN` — a **`read:packages`-only
  PAT** set in the environment-variables panel (not a repo file, not app config; publishing stays in
  CI). Missing → deps don't install and CI stays the gate; `.claude/hooks/session-start.sh` installs
  them once it is set.
- **Lint is unconfigured** (`eslint src/` has no committed config → no-op/fails; CI skips it).
  **Format is unwired** (no prettier dep/config). Do not claim "lint/format pass" — they don't run.

## 6. Validation

- **The gate = `npx tsc --noEmit` && `npx vitest run`** (mirrors CI). tsc must stay at 0.
- Run the narrowest command that proves the change, then the full gate before handoff.
- Establish baseline vs. new failures — don't fix or hide pre-existing failures under an unrelated task.
- Evidence required: paste actual command output. Credential-bound checks that can't run (no
  `NODE_AUTH_TOKEN`) are reported as blocked/UNKNOWN, never as passed.

## 7. Change discipline

- Smallest coherent change. Reuse the canonical owners: `getConfig()`, `createModuleLogger`, the BullMQ
  `scheduler`, `@quantum-l9/llm-router` (via `src/services/llm.ts`) — no parallel frameworks.
- **Multi-tenant:** every operational query/API call/job MUST be `clientId`-scoped. No hardcoded client logic.
- **Async only via BullMQ** in `src/core/scheduler.ts` — no `setTimeout`/`setInterval` for business logic.
  Job handlers MUST be idempotent (a crashed worker may re-run a job).
- **Token discipline:** deterministic code by default; LLM only for judgment. New scheduled jobs define a
  per-job `tokenBudget` (`maxFastTokensPerRun`, `maxStrategicTokensPerRun`, `cooldownMinutes`) in the
  `JOB_DEFINITIONS` registry.
- **New integration:** add its env vars to the Zod schema in `src/core/config.ts`; never hardcode secrets.
- **Schema change:** edit `schema.ts`/`schema-extensions.ts`, generate a migration
  (`npx drizzle-kit generate`), keep `migrate.ts` applying it. **Never edit an existing migration file.**
- Keep `schema_version '2.0'` back-compat: `src/contracts/website_factory_v2.ts` is a cross-repo contract
  Website-Bot mirrors — field renames are breaking. Update schema + migration + tests + contract together.
- **No browser automation** (Puppeteer/Playwright/OpenClaw) — the bot is headless/API-only.

## 8. Git & PR

- Branch `claude/<topic>` off `main`; conventional commits (`fix(api): …`); create/commit/push without asking.
- Open a PR → `main` when delivery is requested; include generated migrations and a new ADR when the change
  is architectural (per CONTRIBUTING).
- Never modify existing migrations. Never force-push over someone else's work. Never report a push/PR/merge
  you did not observe succeed. No auto-merge without operator authorization.

## 9. Safety boundaries (stop → get operator/ADR sign-off)

- **Live-site mutation (highest blast radius):** `src/services/site-deployment.ts` writes the client's live
  Astro site (GitHub Contents API + Vercel deploy hook); `src/services/plan-executor.ts` drives it. Its job
  `serp:execute-surpass-plans` ships **`enabled: false`** and defaults to `SITE_DEPLOY_DRY_RUN`. **Do not
  enable, un-dry-run, or extend this path without operator sign-off.** Note: this capability conflicts with
  ADR-0001 (single-purpose) / AGENTS §1-history — it exists but is **gated, not blessed**; superseding
  ADR-0001 requires operator approval (§ADR rule below).
- **Execution policy:** `src/core/execution-policy.ts` auto-executes LOW/MED/HIGH and queues only CRITICAL
  for human approval. Don't widen auto-execute or reclassify CRITICAL without sign-off.
- **Secrets/credentials:** never read/commit real `.env`/`.env.local`, never print secret values, never
  commit `NODE_AUTH_TOKEN`. `.env.example` (names only) is fine.
- **DB migrations, publish/registry writes, prod config:** treat as stateful/irreversible — confirm first.
- **ADR rule:** a change conflicting with an accepted ADR must either comply, or ship a superseding ADR
  **with explicit operator approval before coding.**

## 10. Completion checklist

Done = code + tests + contracts/migrations updated together · `npx tsc --noEmit` and `npx vitest run` green
with output shown (or the exact blocker/UNKNOWN stated) · diff reviewed for scope creep · no known
unreported regression · Unknowns recorded, never invented.
