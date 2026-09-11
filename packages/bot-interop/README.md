<!-- L9_META
l9_schema: 1
repo: Quantum-L9/l9-graphiti-memory
path: docs/WIP/l9-bot-memory-integration-pr-pack/repos/Website-Bot/files/packages/bot-interop/README.md
layer: documentation
owner: memory-control-plane
status: active
version: 2.2.0
updated: 2026-07-22
/L9_META -->

# @quantum-l9/bot-interop

Canonical, dependency-free wire contracts shared by Website-Bot and SEO-Bot.

This package owns only transport schemas, integrity sealing, validation, and acknowledgement construction. It does not own either bot's business logic, memory, or persistence.

## Modules

| Module | Owns |
|---|---|
| `handoff` | `WebsiteFactoryHandoffV3` schema, canonical JSON, sealing and validation of the Website-Bot → SEO-Bot registration handoff. |
| `ack` | `SeoBotRegistrationAck` construction and validation. |
| `website-intelligence` | Build-time intelligence artifact schemas, integrity sealing and refs (`l9.website-intelligence`). |
| `posthog-events` | The PostHog event vocabulary (`POSTHOG_EVENTS`) every generated site emits and SEO-Bot's Behavior Intelligence joins on, plus `POSTHOG_SITE_EMITTED_EVENTS` and the dual-emit transition map `POSTHOG_LEGACY_EVENT_ALIASES`. Neither bot may spell an event name as a literal. |

Every `src/*.ts` file is part of the WBV2-014 canonical source set: change it in one repo, regenerate `contracts/BOT_INTEROP_PARITY.json` with `node scripts/validate-interop-parity.mjs --write`, and commit the same files in the peer.
