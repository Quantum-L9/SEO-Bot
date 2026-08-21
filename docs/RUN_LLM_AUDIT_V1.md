# `l9.seo-bot-run-llm-audit/v1` — consumer contract

Per-run LLM execution evidence for one SEO-Bot build-intelligence run, produced
as a by-product of the run itself and read back over the existing machine-
authenticated API boundary. Website-Bot is the named consumer.

Nothing on this path is offline: `scripts/build-intelligence/producer-seam-proof.ts`
is an evidence *script* and is **not** required to retrieve production evidence.

## Run identity

One build-intelligence run is three HTTP calls (competitive-landscape →
seo-content-blueprint → structured-content). SEO-Bot derives its own id for that
run, so producer and consumer can address it with no handshake:

```
seo_run_id = "seo-run:" + sha256_hex(client_id + "\n" + build_id)
```

A consumer that correlates on its **own** run id may pass it as an optional
`run_ref` on any of the three producer requests. When supplied, the exported
`run_id` is that value and `run_id_source` is `consumer_supplied`. `seo_run_id`
is always the derived id and remains the store key, so retrieval is unaffected.
Without a `run_ref`, `run_id === seo_run_id` and `run_id_source` is `derived`.

All three legs must agree: a leg naming a different run than an earlier one is a
recorded conflict that fails the audit rather than overwriting it.

Every producer response also carries the header `x-l9-seo-run-id`, which is the
derived id — the addressable one.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/build-intelligence/run-evidence?client_id=…&build_id=…` | By run identity |
| `GET` | `/api/build-intelligence/run-evidence/:run_id` | By `seo_run_id` (the store key) |

Auth: the same `SEO_BOT_API_KEY` machine credential as the three producers
(`Authorization: Bearer …`). No LLM call and no paid provider call is made.

| Status | Meaning |
| --- | --- |
| `200` | The assembled, validated audit |
| `400` | Query is missing `client_id` / `build_id` |
| `401` | Missing or wrong machine credential |
| `404` | `RUN_EVIDENCE_NOT_FOUND` — unknown or evicted run |
| `422` | `RUN_LLM_AUDIT_INVALID` — the run's evidence contradicts itself; the body lists every `violations[]` entry |

`GET` is safe to call after any leg; `legs.*` reports which legs have run.

## Payload

```jsonc
{
  "schema": "l9.seo-bot-run-llm-audit/v1",
  "run_id": "…",              // the consumer's run_ref, or seo_run_id
  "seo_run_id": "seo-run:…",  // always SEO-Bot's derived id
  "run_id_source": "derived", // "consumer_supplied" | "derived"
  "client_id": "…",
  "build_id": "…",
  "produced_at": "2026-08-21T00:00:00.000Z",
  "producer": { "repo": "SEO-Bot", "version": "2.1.0" },
  "legs": {
    "competitive_landscape": true,
    "seo_content_blueprint": true,
    "structured_content": true
  },

  // Deterministic rank authority: measured, and required to be 0.
  "competitive_landscape": {
    "executed": true,
    "ranking_llm_calls": 0
  },

  // The split the producer actually performed (the model never chooses batching).
  "seo_content_blueprint": {
    "executed": true,
    "route_count": 29,
    "batch_size": 4,
    "batch_count": 8,
    "completed_batches": 8
  },

  // Per-route generation ownership — never a package total divided by a route
  // count, never a hardcoded 1.
  "structured_content": {
    "executed": true,
    "route_results": [
      {
        "route_id": "home",
        "path": "/",
        "generation_calls": 1,
        "repair_attempts": 0,
        "semantic_validation_calls": 1
      }
    ]
  },

  // One entry per ACTUAL router call, carrying the policy the ROUTER applied.
  "operations": {
    "SEO_CONTENT_BLUEPRINT": [
      {
        "operation": "SEO_CONTENT_BLUEPRINT",
        "purpose": "[build-intelligence] seo-content-blueprint:batch-1:build-1",
        "attempt": "initial",              // "initial" | "repair"
        "task_id": "…",                    // router-assigned id of the routed call
        "provider": "openrouter",
        "model": "…",
        // Verbatim router evidence, so these two keep the router's camelCase
        // spelling and record the enum NAME.
        "searchRequired": false,             // APPLIED by the router
        "searchPolicySource": "EXPLICIT",    // APPLIED by the router
        "descriptor_requires_search": false, // what the governed op supplied
        "outcome": "SUCCESS"
      }
    ],
    "STRUCTURED_CONTENT_GENERATION": [],
    "CONTENT_VALIDATION": []
  },

  // Counters are LENGTHS of the event lists beside them.
  "direct_provider_bypass_count": 0,
  "direct_provider_bypasses": [],
  "unsupported_capability_combination_count": 0,
  "unsupported_capability_combinations": [],

  // Router calls that could not be attributed exactly. Non-empty ⇒ 422.
  "attribution_failures": []
}
```

## How each number is obtained

| Field | Measured where |
| --- | --- |
| `competitive_landscape.ranking_llm_calls` | `createCompetitiveLandscape`'s own evidence summary (the ranking path imports no LLM service). |
| `seo_content_blueprint.batch_size` / `batch_count` | The producer's deterministic `chunkRoutes` split. `completed_batches` is counted as batches finish. |
| `structured_content.route_results[].generation_calls` | A **per-route** counter incremented in `LlmService.executePolicyJson` after each actual `L9LLMRouter.execute` returns. |
| `structured_content.route_results[].repair_attempts` | The deterministic image of the authoritative `repaired_route_ids`: repaired → `1`, unrepaired → `0`. Cross-checked against `generation_calls` before it can be reported. |
| `operations.*` | The router's own `RoutingDecision` call log, claimed one decision per actual call. `searchPolicySource` is the router enum's NAME, mapped by name so an unrecognised value is rejected rather than normalized. |
| `direct_provider_bypass_count` | Published by the one sanctioned direct-provider site (`aeo-geo:answer-engine-observation`) on every invocation. |
| `unsupported_capability_combination_count` | Caught where `UnsupportedCapabilityCombinationError` surfaces — the router raises it during route resolution, so it never reaches the router's call log. |

## Fail-closed guarantees

`assertRunLlmAudit` re-derives everything it can before an audit may be
returned. A `200` therefore means all of the following held:

- Both counters equal the length of their evidence lists.
- `attribution_failures` is empty.
- `seo_run_id` is the deterministic id of `(client_id, build_id)`, and `run_id`
  agrees with `run_id_source`.
- `competitive_landscape.ranking_llm_calls === 0`.
- `batch_count === ceil(route_count / batch_size)` and `completed_batches === batch_count`.
- Every route: `generation_calls === repair_attempts + 1`, `repair_attempts ≤ 1`, unique `route_id` and `path`.
- `Σ route_results[].generation_calls` equals the number of router decisions
  attributed to `STRUCTURED_CONTENT_GENERATION` — two independent measurements
  of the same quantity must agree.
- Every recorded call: `outcome === "SUCCESS"`, `search_required === false`, and
  `searchPolicySource === "EXPLICIT"` **only** when the governed operation
  supplied a `requiresSearch` boolean equal to the applied value.

Unknown fields are rejected; the document is strict, not extensible in place.

## Retention

Evidence is retained in-process for the most recent `RUN_EVIDENCE_CAPACITY`
(256) runs and is not persisted. Read it during or shortly after the build.
An evicted or unknown run answers `404` — it is never reconstructed from
defaults.

## Consumer parity

The field names and spellings above are a cross-repository contract, not
cosmetic. `searchRequired` / `searchPolicySource: "EXPLICIT"` are the spelling
the governed-run oracle requires of the receipt these values end up in, and
`competitive_landscape.ranking_llm_calls`, `seo_content_blueprint.batch_size` /
`batch_count`, and `structured_content.route_results[].generation_calls` /
`repair_attempts` are read at exactly those paths by the consumer — which
refuses to default any of them.

`tests/build-intelligence/run-evidence-store.test.ts` pins them literally
rather than through the exported types, because a rename that type-checks would
still break the consumer.
