import type { LLMRoutePlan } from './contracts.js';
export interface ModelCapability {
    provider: string;
    model: string;
    modality: 'text' | 'vision' | 'multimodal';
    max_context_tokens: number;
    max_output_tokens: number;
    supports_json_mode: boolean;
    supports_search: boolean;
    supports_citations: boolean;
    supports_tools: boolean;
    supports_streaming: boolean;
    pricing_version: string;
}
export interface LLMRequest {
    system_prompt: string;
    user_prompt: string;
    images?: readonly string[];
    signal?: AbortSignal;
}
export interface ExecutionContext {
    trace_id: string;
    attempt_id: string;
    deadline_at: string;
}
export interface LLMExecutionResult {
    output: string;
    provider_request_id: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost: number;
    latency_ms: number;
    citations: readonly string[];
    finish_reason: string | null;
    pricing_version: string;
}
export type AdapterFailureKind = 'network' | 'timeout' | 'rate_limit' | 'server' | 'client' | 'cancelled';
export interface LLMProviderFailure {
    provider: string;
    kind: AdapterFailureKind;
    retryable: boolean;
    message: string;
    status: number | null;
    provider_request_id: string | null;
    retry_after_ms: number | null;
}
export interface LLMProviderAdapter {
    readonly provider: string;
    capabilities(): readonly ModelCapability[];
    execute(plan: LLMRoutePlan, request: LLMRequest, context: Readonly<ExecutionContext>): Promise<LLMExecutionResult>;
}
//# sourceMappingURL=provider-adapter.d.ts.map