# L9 LLM Control Plane: Phase 1 Kernel

## Status

Phase 1 is an internal, additive contract kernel. It is compiled but not exported from `package.json`, performs no provider calls, and does not replace `L9LLMRouter`.

## Eight-phase trajectory

1. Contract kernel
2. Provider adapters
3. Canonical route matrix and loader
4. Evidence and signals
5. Fitness engine
6. Promotion workflow
7. Frontier lab
8. Measured legacy cutover

Only Phase 1 is present. Promotion and cutover remain blocked.

## Identity model

- `route_fingerprint` identifies equivalent routing decisions. It excludes request IDs and explanatory route, budget, and provider-health prose.
- `plan_id` identifies one request-specific plan from the request ID and route fingerprint.
- `content_hash` protects the complete immutable artifact, including explanatory fields.

Canonical hashing normalizes Unicode to NFC, sorts object keys ordinally, normalizes negative zero, and rejects non-finite numbers, undefined values, cycles, sparse arrays, exotic objects, symbol keys, accessors, non-enumerable properties, and normalization-colliding keys.

Builders run the same safe canonicalization before schema validation. Invalid runtime objects therefore fail with a controlled `ControlPlaneValidationError` rather than executing accessors or overflowing on cycles.

## Contract behavior

Every persistent contract has:

- an explicit schema version
- a strict Zod 4 schema
- derived TypeScript types
- deterministic builder functions
- content or identity hashes
- verification functions
- contradiction checks
- immutable returned values

Set-like arrays are normalized, sorted, and deduplicated before hashing. Unknown fields are rejected.

## Boundaries

The kernel owns contracts, validation, deterministic builders, canonical identity, policy interfaces, and provider-adapter interfaces. It does not own Gate ingress, TransportPacket authority, Graphiti or Neo4j writes, provider SDKs, live network calls, tenant-specific behavior, promotion, or mutable process state.

The canonical internal entry point is `src/control-plane/index.ts`. It exists to define the Phase 1 module boundary and is intentionally absent from public package exports.
