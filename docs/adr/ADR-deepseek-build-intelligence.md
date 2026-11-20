<!-- L9_META: layer=architecture, role=llm_provider_adr, status=accepted, version=1.0.0 -->
# ADR: Direct DeepSeek for Build Intelligence

## Status
Accepted.

## Date
2026-11-19

## Authority
Operator instruction for the redesign research recovery: SEO-Bot build-intelligence calls DeepSeek directly. Other SEO-Bot callers stay on `@quantum-l9/llm-router`.

## Context
Build-intelligence preflight refused to run unless `@quantum-l9/llm-router` resolved, and the integrity receipt rejected a direct provider call. The blueprint, structured-content, and content-validation producers are the build-intelligence LLM path. Search-grounded and other SEO-Bot modules still declare tasks through the router.

## Decision
1. `src/build-intelligence/deepseek-llm.ts` is the build-intelligence provider adapter. It calls `https://api.deepseek.com/chat/completions` with `DEEPSEEK_API_KEY`. The default model is `deepseek-flash`. `DEEPSEEK_MODEL` and `DEEPSEEK_BASE_URL` may override those values. There is no second provider and no automatic model escalation.
2. `seo-content-blueprint.ts`, `structured-content.ts`, and `content-validator.ts` use that adapter when the caller does not inject an LLM. `getLlmService()` remains the router adapter for every other caller.
3. Preflight checks 5, 6, 7, and 9 require `DEEPSEEK_API_KEY`. They do not require `@quantum-l9/llm-router` to resolve. Check 9 keeps the name `llm_router_compatible`.
4. An integrity receipt for `seo_blueprint` and an executed `structured_content` leg passes only when `router_only_llm` is false and `direct_provider_calls` is at least 1.
5. Each call still allows one bounded JSON repair and fails closed on a truncated finish. The run recorder receives one decision whose provider is `deepseek`.

## Consequences
A build-intelligence run does not need OpenRouter, Perplexity, or a resolvable llm-router package. Modules outside this path still do. The receipt field `router_only_llm` stays in the schema and is false for these two legs.
