# Readiness Model

Readiness is a profile result for one commit, not a permanent repository property.

## Layers

### Code readiness

Established by the CI profile. It covers source integrity, typecheck, lint, tests, build, disposable migrations, manifest alignment, and documentation claims.

### Release readiness

Established by the release profile. It adds production-image construction, dependency pruning, non-root execution, disposable service startup, migration, and health verification.

### Operational readiness

Established by the production profile. It adds read-only checks against the deployed service, tenant configuration, scheduler safety state, and PostHog access.

## Decision rules

- A receipt applies only to its recorded commit SHA.
- `PASS` is the required production-profile outcome.
- `PASS_WITH_FINDINGS` is allowed only where the profile policy explicitly permits it.
- `BLOCKED`, `FAIL`, and `UNKNOWN` prevent approval for that profile.
- New commits require new evidence.
- A healthy process does not prove tenant, PostHog, migration, or release readiness by itself.

## Non-goals

These profiles do not prove future third-party availability, SEO outcome quality, business return, or that an operator will follow the runbook. Those require operational metrics and human accountability.
