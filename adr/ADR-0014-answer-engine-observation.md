<!-- L9_META: layer=architecture, role=answer_engine_observation_adr, status=accepted, version=1.0.0 -->
# ADR-0014: Answer Engine Observation Is a Measurement Adapter

## Status
Accepted.

## Date
2026-08-14

## Context
AEO/GEO requires observing whether specific answer engines cite the client.

When measuring a named answer engine, provider identity is part of the experiment
and cannot be delegated to a generic model-selection policy.

This is distinct from general reasoning.

## Decision
SEO-Bot will introduce:

```
AnswerEngineObservationPort
```

with semantics equivalent to:

```
observe:
  engine: perplexity
  query: ""
  target_domain: ""
```

Supported implementations may intentionally call the exact engine being measured.

The adapter returns normalized observation evidence:

```
engine: ""
query: ""
observed_at: ""
response_excerpt: ""
citations: []
target_cited: false
target_url: null
competitor_citations: []
```

Provider-specific HTTP/API logic lives **only** inside this adapter.

The observation result is evidence. It is **not** an SEO strategy, ranking truth,
content-generation result, or final factual adjudication.

General modules may **not** directly call Perplexity or another answer-engine API.

## Consequences
- The architecture permits legitimate provider-specific measurement without
  creating a general provider bypass.
- AEO observations remain comparable over time even if the preferred reasoning
  model changes.

## Validation / Evidence
- Static checks reject direct answer-engine API hostnames outside approved
  observation adapters.
- Integration tests verify the adapter records engine identity and observation
  provenance.

## Related
- ADR-0011 (Search, Reasoning, and Provider Isolation) — the single sanctioned
  exception to provider isolation.
- ADR-0012 (CompetitiveLandscape Authority) — observation evidence is not ranking
  truth.
