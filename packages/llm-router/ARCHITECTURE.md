# Architecture

`@quantum-l9/llm-router` is a reusable TypeScript routing library. `L9LLMRouter` is the supported production execution surface and the only component that composes routing, budget, resilience, and provider dispatch.

## Runtime flow

```text
validated execution task
  -> effective image set merged into task
  -> capability resolution + fail-closed validation
  -> pure route resolution (single decision)
  -> request identity and timestamp
  -> atomic process-local budget reservation
  -> provider-family-safe downgrade
  -> per-provider circuit permit
  -> provider dispatch with explicit cancellation and timeout
  -> aggregate execution accounting
  -> budget reconciliation and audit log
```

Route resolution is pure. Request IDs and timestamps are added afterward and do not participate in routing equivalence.

## Capability authority

The application declares the capability; the router selects the provider. One authority chain turns a `TaskDescriptor` into one decision that both routing and dispatch consume:

```text
TaskDescriptor
  -> resolveCapabilities (search, source, vision, images)
  -> validateCapabilities (fail closed on unsupported combinations)
  -> resolve provider/model
  -> reserve budget
  -> dispatch EXACT resolved capability
```

`resolveSearchPolicy()` in `src/matrices/search-policy.ts` is the single implementation of the search rule:

```text
typeof task.requiresSearch === 'boolean'
  -> { required: task.requiresSearch, source: EXPLICIT }
otherwise
  -> { required: isSearchTask(task.type), source: TASK_DEFAULT }
```

`requiresSearchProvider()` is a boolean view of it and `isSearchTask()` supplies only the `TaskType` default. `resolveCapabilities()` composes the search policy with the canonical vision-task inventory (`VISION_TASKS`, owned by `search-policy.ts`) and the effective image set. `resolveRoute()` consumes the validated capabilities and copies `searchRequired`, `searchPolicySource`, and `visionRequired` onto every `RoutingResolution`; `dispatchProvider()` branches on the same decision fields and asserts the provider contract each branch requires. Dispatch never re-derives a plane from the raw task.

Fail-closed validation refuses every combination the provider plane would silently drop, before any budget reservation or provider dispatch:

| Combination | Error code |
| --- | --- |
| Vision task without images | `VISION_INPUT_REQUIRED` |
| Search + vision together | `UNSUPPORTED_CAPABILITY_COMBINATION` |
| Images on a non-vision task | `IMAGES_NOT_SUPPORTED_FOR_TASK` |
| `recency` / `domainFilter` without search | `SEARCH_MODIFIER_WITHOUT_SEARCH` |
| `consensus` on a non-search route | `CONSENSUS_REQUIRES_SEARCH` |

Three invariants keep the audit honest:

- A resolved Perplexity config always has `disableSearch: false`, and `resolvePerplexityConfig()` refuses non-search tasks. A search decision can never dispatch a config with web search turned off.
- Before dispatch, `decision.searchRequired` must equal `decision.provider === Provider.PERPLEXITY`. A disagreement in either direction is a hard error, not a downgrade.
- Failed routed calls are auditable: `RoutingDecision` records `outcome`, `failureKind`, and `errorCode` on failure, without ever logging prompts, keys, or image contents.

Because every refusal precedes reservation and permit acquisition, none of them can affect budget state or provider circuit health.

## Module ownership

```text
src/types.ts                     public legacy contracts
src/schemas.ts                   runtime validation for public legacy input
src/matrices/*                   deterministic model resolution plus capability authority
src/pricing.ts                   canonical OpenRouter price table
src/budget/*                     process-local admission and spend accounting
src/circuit-breaker.ts           process-local provider health control
src/provider-errors.ts           typed failure classification and redaction
src/providers/*                  provider I/O and SDK transport isolation
src/vision/*                     vision configuration and task planning
src/index.ts                     composition root and supported execution API
src/control-plane/*              internal Phase 1 contract kernel
```

## Provider boundary

Provider clients live under `src/providers/`. Production modules outside `src/index.ts` and `src/providers/` may not import them. ESLint and a programmatic probe enforce the rule.

Existing provider subpath exports remain available during the 1.x line for compatibility. They are deprecated because direct use bypasses budget and circuit controls. Their removal requires a major version.

## Budget state

The built-in budget tracker owns committed spend and active reservations. Admission evaluates both, so concurrent requests inside one JavaScript process cannot all pass against the same unreserved ceiling.

Critical tasks retain the documented override but still reserve and record cost. Reservation identifiers must be non-empty and unique. Client and direct tracker configuration is runtime validated.

The tracker is not a distributed ledger. Multiple processes require an external atomic persistence adapter, which is outside this repository's current scope.

## Circuit state

The circuit breaker owns independent state per provider.

- Closed calls receive ordinary permits.
- The failure threshold opens the circuit.
- The cooldown permits exactly one half-open probe.
- Retryable network, timeout, rate-limit, and server failures count.
- Client, cancellation, budget, policy, and local validation failures do not count.
- Late results from calls acquired before a circuit opened cannot overwrite newer state.

## Provider execution

The OpenAI SDK is isolated behind `OpenAIChatTransport`. SDK retries are disabled. The router controls fallback order explicitly.

OpenRouter fallbacks advance only after retryable failures. Non-retryable client failures and cancellation terminate immediately.

Perplexity consensus executes configured variations in parallel. The selected content remains one successful candidate, while budget-facing cost and token accounting aggregate all successful variations.

## Image safety

Image execution accepts public HTTPS URLs and bounded supported image data URIs. Local, private, loopback, link-local, reserved, and local-domain targets are rejected before dispatch. Option-supplied images are validated and included in route selection before budget reservation.

## Control Plane Phase 1

The Control Plane kernel owns strict runtime contracts, canonical JSON, deterministic identity, immutable builders, policy interfaces, and provider-adapter interfaces. It does not own provider clients, network access, Gate ingress, TransportPacket authority, Graphiti, Neo4j, promotion, mutable global state, or legacy cutover.

The internal barrel `src/control-plane/index.ts` is a deliberate module boundary but is absent from package exports. The one-line pass-through type module was removed because it had no independent responsibility.

Route identity excludes request-specific values and explanatory prose, including route, budget, and provider-health reasons. Complete content hashing still protects those fields.

## Runtime support

The package preserves a Node 20.19.0 compatibility floor for the 1.x line. CI validates the floor plus maintained Node 22 and Node 24 LTS lines. Publish and supply-chain jobs run on Node 24 LTS.
