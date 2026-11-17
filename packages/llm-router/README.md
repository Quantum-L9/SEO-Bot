# @quantum-l9/llm-router

`@quantum-l9/llm-router` is the shared TypeScript routing library for L9 applications. It validates task input, selects a provider and model deterministically, reserves budget before dispatch, applies provider-family-safe downgrades, controls provider failure pressure, executes through typed provider clients, and reconciles actual cost.

## What is implemented

- Deterministic routing for search, general, and vision task families
- Per-client and global process-local budget enforcement with pre-dispatch reservations
- Per-provider circuit breaking with one half-open recovery probe
- Explicit timeout, cancellation, retry, fallback, and provider-error classification
- OpenRouter and Perplexity clients through an OpenAI SDK transport boundary
- Bounded image URL and inline-image validation
- Runtime validation with Zod 4
- Internal Control Plane Phase 1 contracts, canonical hashing, builders, and boundaries
- Package, declaration, lint-boundary, audit, and isolated-consumer validation

## Installation

Install from public git. No `NODE_AUTH_TOKEN` and no `npm.pkg.github.com`.

```bash
npm install git+https://github.com/Quantum-L9/LLM-Router.git#v1.3.1
```

The tag includes compiled `dist/` so hosted `npm ci --ignore-scripts` gets a real `dist/index.js`. Nested `@quantum-l9/graphiti-memory-client` is vendored as `file:packages/graphiti-memory-client` and does not resolve on the public npm registry.

Operator `npm publish` still uses `publishConfig.registry` (GitHub Packages). Consumers do not need that registry. Do not commit package tokens or provider credentials.

## Supported runtimes

The 1.x compatibility floor remains Node.js `20.19.0`. CI also validates maintained Node.js 22 and 24 LTS lines. Release and supply-chain jobs run on Node.js 24 LTS.

## Basic use

```ts
import {
  L9LLMRouter,
  TaskComplexity,
  TaskType,
} from '@quantum-l9/llm-router';

const router = new L9LLMRouter({
  perplexityApiKey: process.env.PERPLEXITY_API_KEY!,
  openrouterApiKey: process.env.OPENROUTER_API_KEY!,
  providerTimeoutMs: 60_000,
  providerMaxRetries: 0,
});

router.initClient('tenant-a', {
  monthlyBudgetPerClient: 200,
  weeklyTarget: 50,
  weeklyHardCeiling: 100,
});

const result = await router.execute(
  {
    clientId: 'tenant-a',
    type: TaskType.CONTENT_GENERATION,
    complexity: TaskComplexity.MEDIUM,
    expectedOutputTokens: 1_500,
  },
  'You are a careful writer.',
  'Draft the article.',
);
```

`execute()` requires a non-empty `clientId`. The router rejects malformed execution input before allocating a request ID, reserving budget, or dispatching a provider call.

## Custom OpenRouter endpoint

The OpenRouter provider targets `https://openrouter.ai/api/v1` by default. Any OpenAI-compatible endpoint (corporate gateway, proxy, or self-hosted backend) can be substituted without code changes:

```ts
// Option 1 — explicit config (highest precedence)
const router = new L9LLMRouter({
  perplexityApiKey: process.env.PERPLEXITY_API_KEY!,
  openrouterApiKey: process.env.OPENROUTER_API_KEY!,
  openrouterBaseUrl: 'https://llm-gateway.internal.example/v1',
});

// Option 2 — environment variable (used when config omits openrouterBaseUrl)
// OPENROUTER_BASE_URL=https://llm-gateway.internal.example/v1
```

Resolution precedence is explicit config, then `OPENROUTER_BASE_URL`, then the OpenRouter cloud default. Overrides are validated as absolute http(s) URLs at construction time and trailing slashes are normalized. Invalid values throw `InvalidBaseUrlError` (or `RouterConfigValidationError` at config parse time). Deployments that set neither are unaffected.

## Search policy

An application declares *what capability the task needs*. The router decides *which provider and model* serve it. `TaskDescriptor.requiresSearch` is the capability declaration, and when it is present it is authoritative:

```ts
shouldSearch(task) =
  typeof task.requiresSearch === 'boolean'
    ? task.requiresSearch
    : isSearchTask(task.type);
```

| `requiresSearch` | Result | `searchPolicySource` |
| --- | --- | --- |
| `true` | Search plane (Perplexity Sonar) | `EXPLICIT` |
| `false` | General plane, even for a research `TaskType` | `EXPLICIT` |
| omitted | The historical `TaskType` default | `TASK_DEFAULT` |

The `TaskType` default is unchanged: `COMPETITOR_RESEARCH`, `CITATION_CHECK`, `FACT_VERIFICATION`, `MARKET_RESEARCH`, and `LINK_PROSPECTING` still route to search when the flag is omitted. Explicit `false` lets a caller reason strategically over evidence a deterministic system already gathered without paying for redundant web search; explicit `true` lets an otherwise-general task reach fresh web context.

```ts
// Strategic synthesis over evidence we already hold — no web search.
await router.execute(
  { clientId: 'tenant-a', type: TaskType.COMPETITOR_RESEARCH, complexity: TaskComplexity.HIGH, requiresSearch: false },
  'You are a strategist.',
  'Synthesize the supplied competitor evidence.',
);
```

`TaskDescriptor` carries no `provider`, `model`, or fallback-chain field, and unknown keys are stripped during validation. Applications cannot select a provider or model.

### Auditing a routing decision

Every `RoutingDecision` — from `route()` and from `getCallLog()` — reports whether search was selected and on whose authority (`searchRequired`, `searchPolicySource`), whether the route is vision-backed (`visionRequired`), and, after execution, the call outcome: `actualCost`, `latencyMs`, and for failed routed calls `outcome: 'FAILED'` with `failureKind` and `errorCode`. The same decision object drives dispatch, so the audit can never disagree with what actually executed. No credentials, prompts, or image contents are recorded.

```ts
const decision = router.route({ clientId: 'tenant-a', type: TaskType.MARKET_RESEARCH, complexity: TaskComplexity.HIGH, requiresSearch: false });
decision.searchRequired;      // false
decision.searchPolicySource;  // SearchPolicySource.EXPLICIT
decision.provider;            // Provider.OPENROUTER
```

`searchRequired` always agrees with the plane actually dispatched; the router asserts this in both directions before any provider call.

### Unsupported capability combinations

The router fails closed on every capability combination the provider plane cannot execute faithfully — nothing is silently dropped:

| Combination | Error code |
| --- | --- |
| Visual task without images | `VISION_INPUT_REQUIRED` |
| Search and vision together | `UNSUPPORTED_CAPABILITY_COMBINATION` |
| Images on a non-visual task | `IMAGES_NOT_SUPPORTED_FOR_TASK` |
| `recency` / `domainFilter` without search | `SEARCH_MODIFIER_WITHOUT_SEARCH` |
| `consensus` on a non-search route | `CONSENSUS_REQUIRES_SEARCH` |

All of these throw `UnsupportedCapabilityCombinationError` before any budget reservation, circuit permit, or provider dispatch, so an invalid request never half-executes and never affects budget state or circuit health. Split search+vision work into a vision task and a search task.

## Vision execution

Images supplied through execution options are merged into the validated task before routing. This ensures model selection and budget estimation use the same image count that reaches the provider.

A vision task without images fails closed with `VISION_INPUT_REQUIRED` instead of silently degrading to a text-only call, and images attached to a non-visual task fail with `IMAGES_NOT_SUPPORTED_FOR_TASK` instead of being ignored.

```ts
const result = await router.execute(
  {
    clientId: 'tenant-a',
    type: TaskType.SCREENSHOT_ANALYSIS,
    complexity: TaskComplexity.MEDIUM,
  },
  'Inspect the screenshots.',
  'Compare the layouts.',
  {
    images: [
      'https://cdn.example.com/current.png',
      'https://cdn.example.com/competitor.png',
    ],
  },
);
```

Only HTTPS public URLs and bounded `data:image/*;base64` payloads are accepted. Private, loopback, link-local, reserved, local-domain, non-image, and oversized inline targets are rejected before provider dispatch.

## Search consensus

For eligible high-complexity Perplexity tasks, `{ consensus: true }` executes the configured variations in parallel. The returned content is selected from the successful responses, while token and cost fields represent the aggregate successful consensus execution so budget reconciliation does not undercount spend.

Consensus is an execution modifier, not search-policy authority. It applies only to a route that already resolved to the search plane; requesting it on a general or vision route throws `CONSENSUS_REQUIRES_SEARCH` before budget reservation instead of being silently ignored.

## Budget semantics

The built-in tracker is process-local.

1. Estimate the route cost.
2. Evaluate committed spend plus active reservations.
3. Reserve estimated cost before provider dispatch.
4. Release the reservation on confirmed unbilled failure.
5. Reconcile the reservation to actual reported cost on success.

This prevents concurrent overspend inside one process. It does not claim distributed enforcement across processes or machines.

## Provider failure behavior

Provider failures are classified as network, timeout, rate limit, server, client, cancellation, local, or unknown.

- Retryable provider failures may advance through an explicit fallback chain.
- Client errors, cancellation, and local validation failures stop immediately.
- Local validation and budget failures do not poison provider circuit health.
- A circuit permits only one half-open recovery probe.
- Late successes from older calls cannot close a circuit opened by newer failures.

The OpenAI SDK has hidden retries disabled. Every router-controlled fallback remains visible and bounded.

## Direct provider imports

These 1.x compatibility exports remain available:

```ts
import { OpenRouterClient } from '@quantum-l9/llm-router/openrouter';
import { PerplexityClient } from '@quantum-l9/llm-router/perplexity';
```

They are deprecated because they bypass router-level budget and circuit controls. Use `L9LLMRouter` for production execution. Removal requires a future major-version migration.

## Internal Control Plane kernel

Phase 1 Control Plane files are compiled but are not exposed through `package.json` exports. They define strict contracts, deterministic canonicalization, identity verification, immutable builders, policy interfaces, and provider-adapter interfaces. They perform no network calls and do not replace the legacy router.

See [`docs/control-plane-architecture.md`](docs/control-plane-architecture.md).

## Validation

```bash
npm ci
npm run verify:all
```

`verify:all` runs the production build, strict type verification, declaration-consumer compilation, ESLint, the provider-boundary probe, Vitest, production dependency audit, package allowlist inspection, isolated tarball installation, and package export smoke tests.

Operational procedures and failure recovery are documented in [`RUNBOOK.md`](RUNBOOK.md). Architecture and ownership boundaries are documented in [`ARCHITECTURE.md`](ARCHITECTURE.md).
