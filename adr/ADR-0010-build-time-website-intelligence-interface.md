<!-- L9_META: layer=architecture, role=build_time_intelligence_adr, status=accepted, version=1.0.0 -->
# ADR-0010: Build-Time Website Intelligence Interface

## Status
Accepted.

## Date
2026-08-14

## Context
SEO-Bot's single-purpose boundary prohibits it from becoming a site builder, but
Website-Bot requires SEO intelligence before a redesign can be planned or content
can be generated.

Post-launch registration alone is insufficient for this build-time use case.

## Decision
SEO-Bot will expose a build-time intelligence interface while remaining a headless
SEO authority.

The interface may **produce**:

- CompetitiveLandscape
- SEOContentBlueprint
- StructuredContentPackage

The interface may **consume**:

- verified business facts;
- baseline route/content metadata;
- WebsiteBuildBlueprint;
- PageContentContract;
- existing SEO client configuration where available.

This amendment does **not** authorize SEO-Bot to:

- choose visual layouts;
- mutate Website-Bot source;
- build the website;
- deploy the website;
- become the redesign orchestrator.

Website-Bot remains the transaction orchestrator and mutation authority. Existing
post-launch client registration remains a separate lifecycle operation.

## Consequences
- SEO intelligence can participate before site generation without collapsing the
  two repositories into one system.
- The same SEO engine can continue monitoring the released site afterward.

## Validation / Evidence
Contract tests must prove SEO-Bot returns artifacts only and performs no
Website-Bot repository mutation.

## Related
- Amends ADR-0001 (Single-Purpose Dedicated SEO Bot): adds a headless build-time
  interface that produces artifacts without violating the single-purpose boundary.
- `@quantum-l9/bot-interop` `l9.website-intelligence/v1` protocol
- `contracts/WEBSITE_INTELLIGENCE_LOCK.json`
- Website-Bot ADR-0002 (SEO-Bot Build-Time Intelligence Boundary)
