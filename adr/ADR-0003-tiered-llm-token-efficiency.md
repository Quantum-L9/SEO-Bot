# ADR-0003: Tiered LLM Token Efficiency

## Status
accepted

## Date
2026-06-14

## Context
Running an autonomous agent 24/7 can result in massive, unpredictable LLM API costs if every decision or data extraction relies on a large model like GPT-4o. To make the SEO Bot financially viable across dozens of clients, we must drastically reduce token burn without sacrificing the quality of strategic outputs.

## Decision
We will implement a tiered intelligence model with strict token budgeting:
1. **Deterministic Tier ($0):** 95% of operations (API polling, threshold checks, database writes) use pure code.
2. **Fast Tier (~$0.001/call):** Uses smaller models (e.g., `gpt-4o-mini`) strictly for classification, scoring, and simple JSON extraction.
3. **Strategic Tier (~$0.01-0.03/call):** Uses large models (e.g., `gpt-4o` or `claude-3.5-sonnet`) exclusively for complex reasoning, content generation, and surpass plans.

Furthermore, we will enforce a hard daily budget limit (e.g., $5/day) via a circuit breaker pattern.

## Rationale
- Maximizes ROI by matching the cognitive capability of the model to the complexity of the task.
- Prevents runaway costs caused by infinite loops, unexpected API errors, or massive text inputs.
- Forces developers to write deterministic code for routine tasks rather than lazily delegating to the LLM.

## Consequences
- The LLM service must track token usage and cost internally before and after every call.
- The system must handle budget exhaustion gracefully (e.g., skipping strategic jobs while allowing deterministic jobs to continue).
- Prompts must be carefully designed and tested against the specific tier they target.

## Alternatives Considered
- **Single Model Architecture:** Rejected due to excessive cost for simple tasks.
- **Local Open Source Models:** Rejected due to the high infrastructure cost (GPU VPS) required to run models capable of strategic reasoning, which negates the API savings at our current scale.

## Validation / Evidence
- `src/services/llm.ts` implements `fastClient` and `strategicClient`, tracks `dailySpend`, and throws if `dailyBudgetLimit` is exceeded.
- `src/core/scheduler.ts` defines `TokenBudget` (`maxFastTokensPerRun`, `maxStrategicTokensPerRun`) for every job.
- `src/types/index.ts` defines `LlmTier`.

## Related Artifacts
- `src/services/llm.ts`
- `src/core/scheduler.ts`

## Open Questions
- None.
