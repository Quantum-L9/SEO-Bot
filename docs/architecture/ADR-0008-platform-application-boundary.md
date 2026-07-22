<!-- L9_META: layer=architecture, role=boundary_adr, status=accepted, version=1.0.0 -->
# ADR-0008: Website factory systems are platform applications

## Status
Accepted for this release.

## Decision
Website-Bot and SEO-Bot are L9-managed platform applications, not L9 runtime nodes. Website-Bot
owns the site-factory workflow and SEO-Bot owns the maintenance workflow. Their integration is an
authenticated platform API carrying the canonical website-factory handoff, not node-to-node dispatch.

## Consequences
TransportPacket and Gate routing are not required at this boundary. Direct peer discovery remains
forbidden: Website-Bot receives the configured SEO-Bot service URL from the deployment environment,
uses one fixed registration route, sends an idempotency key, and requires a correlated acknowledgement.
If either application is later reclassified as a runtime node, this exception expires and the boundary
must use the canonical Gate and TransportPacket packages. No local Gate, packet, routing, auth, or
resilience implementation may be added to either application.
