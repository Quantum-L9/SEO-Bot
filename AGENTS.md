# AGENTS.md

## Mission

Maintain, extend, and operate the L9 SEO Bot codebase without degrading its multi-tenant architecture, token efficiency, or stability. This file is binding guidance for AI coding agents and developer assistants working in this repository.

## Source-of-Truth Order

1. Current explicit operator instruction.
2. Domain specification and generated contracts (e.g., `contracts/website_factory_integration.yaml`).
3. Existing repository files and ADRs.
4. Machine validation evidence.
5. Root docs in this pack.
6. General best practices.

When sources conflict, stop and report the conflict. Do not silently choose the more convenient answer.

## Locked Decisions

- Framework: Node.js / TypeScript.
- Package manager: npm.
- Architecture: Multi-tenant, single persistent process.
- Job Queue: BullMQ + Redis.
- Analytics: Self-hosted PostHog.
- Readiness claims: Evidence-backed only.

## Allowed Changes

- Fix build, runtime, route, or verification errors.
- Improve scripts when they preserve existing command semantics.
- Update docs to match inspected repo facts.
- Add environment variable names without values.
- Improve command consistency across docs and package scripts.
- Add validation evidence generated from real commands.

## Forbidden Changes

- Do not break multi-tenancy (no hardcoded client logic).
- Do not violate the token budget (95% deterministic, LLM for strategy only).
- Do not bypass the job queue (no raw `setTimeout` for business logic).
- Do not hardcode secrets or commit `.env.local`.
- Do not mark credential-bound checks as passed without runtime evidence.
- Do not use `console.log` (use Pino structured logging).
- Do not modify existing database migration files.
- Do not introduce Puppeteer, Playwright, or OpenClaw dependencies.

## Required Work Loop

1. Inspect files before editing.
2. Identify the smallest change that closes the actual gap.
3. Modify only relevant files.
4. Run the narrowest validation command that proves the fix.
5. Run `npm run verify:all` when preparing handoff.
6. Record Unknowns rather than inventing values.
7. Package only approved outputs (excluding node_modules, secrets, caches).

## Domain Rules

## 1. Core Architecture Boundaries

- **Single Purpose:** This Bot does SEO maintenance. Do NOT add features for site building, Astro deployment, or CMS management.
- **Multi-Tenant Only:** Do NOT write code that assumes the Bot is running for a single client. Every database query, API call, and job execution MUST be scoped by `clientId`.
- **No Browser Automation:** Do NOT introduce Puppeteer, Playwright, or OpenClaw dependencies into this repository. The Bot is strictly headless and relies on APIs.

## 2. Token Efficiency & LLM Usage

- **Tiered Model Rule:** Do NOT use the strategic LLM (`gpt-4o` / `claude-3.5-sonnet`) for simple data extraction, classification, or formatting. You MUST use the fast tier (`gpt-4o-mini`) via `LlmService.classify()` or `LlmService.extractJson()`.
- **Budget Enforcement:** If you add a new job to `src/core/scheduler.ts`, you MUST define a realistic `TokenBudget` (`maxFastTokensPerRun` and `maxStrategicTokensPerRun`).
- **Zero-Token Default:** Prefer deterministic code over LLM calls. Only invoke the LLM when human-like judgment or generation is strictly required.

## 3. Database & State

- **Drizzle ORM:** All database interactions MUST use Drizzle ORM (`src/core/database/schema.ts`). Do not write raw SQL queries.
- **Migrations:** If you modify `schema.ts`, you MUST generate a new migration using `pnpm drizzle-kit generate` and ensure `src/core/database/migrate.ts` can apply it.

## 4. Scheduling & Concurrency

- **BullMQ:** All asynchronous or scheduled work MUST be dispatched through BullMQ in `src/core/scheduler.ts`. Do not use `setInterval` or `setTimeout` for business logic.
- **Idempotency:** Job handlers MUST be idempotent. Assume BullMQ might execute a job twice if a worker crashes mid-execution.

## 5. Security & Credentials

- **Zod Validation:** If you introduce a new API integration, you MUST add the required environment variables to the Zod schema in `src/core/config.ts`.
- **No Hardcoded Secrets:** Never hardcode API keys, database passwords, or PostHog tokens. Always use `getConfig()`.

## 6. Modifying Client Integration

- If you change the Web Vitals tracking or PostHog event structure, you MUST update `client-snippets/posthog-tracking.html`.
- You must ensure the snippet remains lightweight (< 5KB) and does not negatively impact the client site's Lighthouse performance score.

## 7. ADR Compliance

Before making architectural changes, read the ADRs in `adr/`. If your proposed change conflicts with an accepted ADR, you must either:
1. Revise your approach to comply.
2. Write a new ADR superseding the old one, and explicitly request human operator approval before implementing the code.
