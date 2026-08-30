# LLM Router Runbook

## Purpose

This runbook covers local setup, deterministic validation, package inspection, common failure diagnosis, release preparation, and rollback for `@quantum-l9/llm-router`.

## Prerequisites

- Node.js 20.19.0 or newer
- npm 10.9.2 or a compatible npm 10 release
- Access to the package registry when installing dependencies
- No provider credentials are required for tests

The 1.x package retains Node 20 compatibility, but release and supply-chain workflows use Node 24 LTS.

## Clean setup

```bash
rm -rf node_modules dist
npm ci --ignore-scripts
```

Use `npm ci`, not `npm install`, when validating a proposed commit. `npm ci` proves the committed lockfile is reproducible and refuses manifest drift.

## Full validation

```bash
npm run verify:all
```

Expected stages:

1. TypeScript build
2. Strict no-emit typecheck
3. Declaration-consumer compilation
4. ESLint
5. Provider-boundary probe
6. Complete Vitest suite
7. Production dependency audit
8. Package allowlist and isolated-consumer smoke test

A failure in any stage blocks merge or release.

## Focused commands

```bash
npm run build
npm run verify:types
npm run verify:declarations
npm run lint
npm run lint:boundary
npm test
npm run test:inventory
npm audit --audit-level=high --omit=dev
npm run verify:package
```

## Package inspection

```bash
npm pack --json --ignore-scripts
```

The tarball may contain only:

- `package.json`
- `README.md`
- `ARCHITECTURE.md`
- `RUNBOOK.md`
- compiled `dist/` files

`npm run verify:package` enforces this allowlist, installs the tarball into an isolated temporary consumer, and checks the root plus supported subpath exports.

## Provider-boundary failure

Symptom: `npm run lint:boundary` or `tests/eslint-boundary.test.ts` fails.

Recovery:

1. Find the production file importing `src/providers/*`.
2. Route execution through `L9LLMRouter` or move provider I/O into the approved provider boundary.
3. Do not disable the lint rule or add a broad ignore.
4. Rerun `npm run lint:boundary` and the full suite.

## Budget-reservation failure

Symptom: an unknown, duplicate, or already-settled reservation error.

Recovery:

1. Confirm every successful request reconciles exactly once.
2. Confirm every unbilled failure releases exactly once.
3. Confirm the reservation ID factory cannot return duplicates.
4. Inspect `getClientBudgetReport()` for active reservations.
5. Do not mutate internal maps or compensate by recording spend manually.

The tracker is process-local. Cross-process consistency requires an external persistence design and is not implemented in this package.

## Circuit-breaker failure

Symptom: provider calls remain blocked after the cooldown or too many recovery calls escape.

Recovery:

1. Inspect `getCircuitState(provider)`.
2. Confirm every acquired permit is completed with `recordSuccess`, `recordFailure`, or `release`.
3. Confirm only retryable network, timeout, rate-limit, and server failures are counted.
4. Confirm only one half-open probe is active.
5. Do not close an open circuit based on a stale pre-open success.

## Provider fallback failure

Fallbacks advance only after retryable provider failures. A 4xx client error, local validation failure, or cancellation must stop immediately.

Check:

- provider error `kind`
- `retryable`
- provider request ID
- retry-after metadata
- abort signal state

The SDK retry count must remain zero so attempts stay explicit in router behavior.

## Control Plane contract failure

Control Plane builders reject unknown fields, invalid combinations, non-finite values, cycles, accessors, sparse arrays, unsupported objects, and hash mismatches.

Recovery:

1. Validate against the exported Zod schema.
2. Pass plain JSON-compatible values.
3. Normalize unordered sets through the builder rather than precomputing hashes.
4. Rebuild the artifact instead of editing identity fields manually.
5. Run `tests/control-plane/*`.

## Release preparation

1. Rebase onto the intended release base.
2. Run a clean `npm ci --ignore-scripts`.
3. Run `npm run verify:all`.
4. Inspect `npm pack --json --ignore-scripts`.
5. Confirm the version is publishable and has not already been released.
6. Confirm the tag matches the package version.
7. Push the tag only after all release evidence is captured.

The GitHub publish workflow validates again before `npm publish`.

## Rollback

Stop the merge or release train on the first regression.

For an unmerged branch, revert or amend only the failing change and rerun all gates. For a merged regression, revert the most recent merge, validate `main`, and reopen the affected work. Do not stack compensating changes on a red baseline.

For an already published package, npm packages are immutable. Publish a corrected patch version and deprecate the defective version with a clear migration note.
