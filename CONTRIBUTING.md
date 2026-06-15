# Contributing to L9 SEO Bot

This document outlines the rules for contributing to the L9 SEO Bot, specifically focusing on how to propose and document architectural changes.

## Architectural Decision Records (ADRs)

We use ADRs to document significant design decisions. If you are adding a new module, changing the infrastructure, altering the token efficiency model, or introducing a new external dependency, you MUST write an ADR.

### When to write an ADR
- Adding a new external API integration (e.g., switching from DataForSEO to another provider).
- Changing the database schema in a way that affects multi-tenancy.
- Modifying the deployment architecture (e.g., moving away from Docker Compose).
- Introducing a new core capability (e.g., adding a social media posting module).

### How to write an ADR
1. Copy the format from an existing ADR in the `adr/` directory.
2. Name the file `ADR-XXXX-short-title.md`, incrementing the number sequentially.
3. Fill out all required sections:
   - **Title:** Short, descriptive title.
   - **Status:** `proposed`, `accepted`, `rejected`, or `superseded`.
   - **Date:** YYYY-MM-DD.
   - **Context:** What is the problem we are solving?
   - **Decision:** What is the change we are making?
   - **Rationale:** Why is this the best approach?
   - **Consequences:** What does this break, cost, or require?
   - **Alternatives Considered:** What else did we try and why did we reject it?
   - **Validation / Evidence:** How do we know this works?
   - **Related Artifacts:** Which files are affected?
   - **Open Questions:** What is still unknown?
4. Update the index in `adr/README.md`.
5. Update `DECISION_LOG.md` with a summary of the new decision.

## Code Style & Standards

- **TypeScript:** Strict mode is enabled. No `any` types unless absolutely necessary for external untyped libraries.
- **Formatting:** We use Prettier. Run `pnpm format` before committing.
- **Logging:** Do not use `console.log`. Use the structured logger from `src/core/logger.ts` (`logger.info`, `logger.error`).
- **Error Handling:** Fail fast. If an API key is missing, crash on startup. Do not swallow errors in job handlers; let them bubble up so BullMQ can track the failure and apply backoff retries.

## Pull Request Process

1. Create a feature branch from `main`.
2. Ensure `pnpm tsc --noEmit` passes.
3. If database changes are made, include the generated migration files.
4. If architectural changes are made, include the new ADR.
5. Request review from the lead operator.
