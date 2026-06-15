# ADR-0006: Competitor Kill-Chain Pattern

## Status
accepted

## Date
2026-06-14

## Context
Standard SEO monitoring tools simply report ranking drops and leave the analysis to a human. For the SEO Bot to be truly autonomous, it must not only detect when a competitor outranks a client, but automatically diagnose *why* and formulate a plan to reverse it.

## Decision
We implement a continuous "kill-chain" pattern in the SERP Intelligence module:
1. **Identify:** Track rankings daily. If a competitor takes the #1 spot, flag them.
2. **Analyze:** Run an automated gap analysis across 6 dimensions (content depth, schema, backlinks, speed, freshness, SERP features).
3. **Plan:** Pass the gap data to the strategic LLM to generate a specific, prioritized surpass plan.
4. **Execute/Queue:** Autonomous actions are executed by the Bot; human-in-the-loop actions are queued for the operator.
5. **Monitor:** Track the result of the actions. If the position drops >3 spots, trigger immediate re-analysis.

## Rationale
- Replaces the most time-consuming part of human SEO work (competitive auditing).
- Ensures that every ranking loss is met with an immediate, data-backed response plan.
- Standardizing the 6 dimensions ensures consistent, objective analysis rather than subjective guessing.

## Consequences
- Requires continuous API spend (DataForSEO) to monitor SERPs and extract competitor backlink profiles.
- The strategic LLM is invoked every time a significant gap analysis occurs, consuming token budget.

## Alternatives Considered
- **Rule-based Recommendations:** Rejected. Hardcoded rules (e.g., "if competitor has more links, build more links") are too brittle and miss nuanced content or schema advantages.

## Validation / Evidence
- `src/modules/serp-intelligence/index.ts` contains the logic for `analyzeCompetitors` and `generateSurpassPlan`.
- `src/types/index.ts` defines `GapAnalysis`, `GapDimension`, and `SurpassAction`.

## Related Artifacts
- `src/modules/serp-intelligence/index.ts`
- `src/types/index.ts`

## Open Questions
- None.
