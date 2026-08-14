<!-- L9_META: layer=architecture, role=seo_content_blueprint_adr, status=accepted, version=1.0.0 -->
# ADR-0013: SEOContentBlueprint and Strategic Content Compiler

## Status
Accepted.

## Date
2026-08-14

## Context
Website content must jointly satisfy search intent, competitive opportunity,
AEO/GEO requirements, verified business facts, UX purpose, and conversion
architecture.

Sequential "write then SEO rewrite" loops create drift and conflicting authority.

## Decision
SEO-Bot owns SEOContentBlueprint.

For every route it defines at minimum:

- primary and secondary search intent;
- query/topic/entity targets;
- competitive content gaps;
- required subjects;
- question/FAQ opportunities;
- internal-link requirements;
- AEO/GEO requirements;
- structured-data content requirements;
- prohibited unsupported claims;
- SEO acceptance tests.

Website-Bot combines SEOContentBlueprint, WebsiteBuildBlueprint, and verified
business facts into the canonical PageContentContract (deterministic compilation,
no LLM).

SEO-Bot then performs **exactly one** authoritative page-content generation
operation against that contract and returns StructuredContentPackage.

Content generation uses a strong writing/reasoning task class. Search-oriented
providers are not selected merely because the content is SEO content.

SEO-Bot validates its resulting package against SEOContentBlueprint before
returning it.

Website-Bot validates business facts and assembles the approved package but does
**not** independently rewrite SEO page copy.

### StructuredContentPackage (shape)

```
schema: l9/structured-content-package/v1
route: ""
contract_hash: ""
sections: []
metadata:
  title: ""
  description: ""
faqs: []
internal_links: []
schema_content_inputs: {}
validation:
  seo_blueprint_passed: false
  unsupported_claims: []
```

## Consequences
- There is one prose authority per generation transaction.
- SEO requirements exist before writing instead of being patched into copy
  afterward.
- Schema serialization can remain deterministic in Website-Bot.

## Validation / Evidence
- Package `contract_hash` must match the requesting PageContentContract.
- Unsupported-claim validation must pass before assembly.

## Related
- `@quantum-l9/bot-interop` `SEOContentBlueprintV1`, `StructuredContentPackageV1`
- Website-Bot ADR-0002 (SEO-Bot Build-Time Intelligence Boundary), deterministic
  `PageContentContract` compiler
- ADR-0011 (Search, Reasoning, and Provider Isolation)
