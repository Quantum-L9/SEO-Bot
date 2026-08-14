<!-- L9_META: layer=architecture, role=provider_isolation_adr, status=accepted, version=1.0.0 -->
# ADR-0011: Search, Reasoning, and Provider Isolation

## Status
Accepted.

## Date
2026-08-14

## Context
Search retrieval and strategic reasoning are orthogonal capabilities.

A search-grounded provider is not automatically the correct model for synthesis,
content writing, scoring, or strategic reasoning.

## Decision
SEO-Bot retains deterministic/fast/strategic intelligence tiers while adding
explicit capability dimensions:

- `requires_search`
- `requires_reasoning`
- `requires_structured_output`
- `requires_vision`
- `observed_engine`
- `freshness_requirement`

Modules declare these requirements. They do **not** choose models.

General provider/model resolution belongs to `@quantum-l9/llm-router`.

Direct provider HTTP calls are forbidden except through a named observation
adapter defined by ADR-0014.

### Capability Policy

| Capability | Resolution |
|-----------|------------|
| `SERP_RANKING` | deterministic DataForSEO — no LLM |
| `CLASSIFICATION` / `EXTRACTION` / `SIMPLE_SCORING` | small structured model — no search unless explicitly required |
| `WEB_EVIDENCE_RESEARCH` | search-backed provider — citations/provenance required |
| `STRATEGIC_SEO_REASONING` | strong reasoning model — no search when normalized evidence is already supplied |
| `SEO_CONTENT_GENERATION` | strong writing/reasoning model — no search by default |
| `CITATION_OBSERVATION` | exact external engine being measured — provider identity is measurement semantics |

Perplexity is **not** the default provider for competitor synthesis, SEO strategy,
content generation, gap reasoning, or blueprint generation.

Perplexity **may** be eligible for fresh citation-backed research and may be
explicitly selected when Perplexity itself is the observed answer engine.

## Consequences
- Search evidence and reasoning outputs become independently testable.
- Changing the best reasoning model does not change SERP or citation-observation
  semantics.

## Enforcement
- CI rejects hard-coded model/provider selection in SEO modules outside approved
  provider adapters.
- All normal LLM calls traverse `LlmService` and the shared router.

## Validation / Evidence
`src/services/improve-llm-policy.ts` declares capability descriptors only (no
provider/model literals); `assertSeoImprovePolicy()` fails closed if a reasoning
operation requests search or if `FRESH_WEB_EVIDENCE` does not.

## Related
- Amends ADR-0003 (Tiered LLM Token Efficiency): adds explicit capability
  dimensions on top of the existing tiers; provider selection stays in the router.
- ADR-0014 (Answer Engine Observation)
- `@quantum-l9/llm-router` `requiresSearchProvider` policy
