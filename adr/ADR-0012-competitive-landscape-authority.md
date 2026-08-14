<!-- L9_META: layer=architecture, role=competitive_landscape_adr, status=accepted, version=1.0.0 -->
# ADR-0012: CompetitiveLandscape Is the Canonical Competitive Ranking Authority

## Status
Accepted.

## Date
2026-08-14

## Context
"Top ten websites in the niche" must mean something reproducible. Search-grounded
model recommendations are not sufficient evidence of organic ranking.

## Decision
SEO-Bot owns CompetitiveLandscape.

The competitive cohort is calculated from deterministic SERP observations across a
weighted query portfolio.

The process is:

```
business/niche inputs
        ↓
query portfolio
        ↓
DataForSEO SERP observations
        ↓
domain normalization + dedupe
        ↓
non-operating-site exclusion
        ↓
weighted visibility aggregation
        ↓
qualified Top-10 donor cohort
```

Each selected domain must retain:

- query;
- rank;
- URL;
- observation timestamp;
- geography/device context;
- provider evidence;
- aggregate visibility contribution.

Directories, social networks, marketplaces, publishers, and lead aggregators are
excluded unless explicitly part of the competitive class under study.

Perplexity is **not** ranking authority.

An LLM may classify ambiguous domains or search intent, but it may not invent or
override observed rank.

### Consumers
CompetitiveLandscape is consumed by:

- Website-Bot for donor UX/design/IA/conversion analysis;
- SEO-Bot for content and search-gap analysis.

Both systems use the same cohort version/hash.

## Consequences
There is one competitive truth rather than independent Website-Bot and SEO-Bot
competitor lists.

## Validation / Evidence
- Every selected Top-10 donor resolves to underlying rank observations.
- Cohort generation is replayable from persisted inputs.

## Related
- `@quantum-l9/bot-interop` `CompetitiveLandscapeV1` (`source: 'dataforseo'`)
- Website-Bot ADR-0004 (Competitive Pattern Harvest and Blueprint Gate)
- ADR-0011 (Search, Reasoning, and Provider Isolation)
