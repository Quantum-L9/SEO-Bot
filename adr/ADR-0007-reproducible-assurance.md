# ADR-0007: Reproducible, commit-bound assurance

- Status: accepted
- Date: 2026-07-20

## Context

The repository previously contained static validation labels, an incomplete aggregate command, optional lint, mixed package-manager instructions, and readiness claims not bound to executed evidence. Operators and agents could not reproduce the claimed result for an exact revision.

## Decision

Adopt one assurance control plane with:

- npm 10 and a committed package lock
- Canonical statuses: `PASS`, `PASS_WITH_FINDINGS`, `BLOCKED`, `FAIL`, and `UNKNOWN`
- CI, release, and production profiles
- Generated, redacted, digested evidence tied to a full commit SHA
- Disposable PostgreSQL and container validation
- Read-only production checks
- Generated repository manifests enforced in CI

## Consequences

- CI requires Docker and authenticated private-package access.
- The initial lockfile requires an operator with `read:packages` credentials.
- Release evidence takes longer than unit-only CI.
- Missing external prerequisites remain visible as blockers.
- Documentation cannot carry a hand-maintained current readiness status.

## Alternatives considered

### Keep shell-only scripts

Rejected because result normalization, dependency routing, evidence schemas, redaction, and deterministic receipts become fragmented.

### Commit generated validation results

Rejected because committed results become stale on the next commit and encourage false current-state claims.

### Validate migrations against a shared database

Rejected because it is unsafe, stateful, and non-reproducible.

## Validation

The assurance engine has unit tests for status aggregation, command execution, redaction, schema validation, profile loading, manifest generation, and manifest drift. The complete repository profile remains responsible for proving integration with the application.

## Related artifacts

- `scripts/validation/`
- `validation/policy.yaml`
- `validation/schemas/`
- `scripts/manifest/`
- `manifest/ownership.yaml`
- `.github/workflows/ci.yml`
- `VALIDATION.md`
