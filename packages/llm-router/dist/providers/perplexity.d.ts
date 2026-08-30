import { ProviderRequestError } from '../provider-errors.js';
import { type LLMResponse, type PerplexityConfig } from '../types.js';
import { type ChatMessage, type ChatTransport } from './openai-transport.js';
export interface PerplexityClientLike {
    complete(config: PerplexityConfig, systemPrompt: string, userPrompt: string, assistantContext?: string, signal?: AbortSignal): Promise<LLMResponse>;
    completeWithConsensus(config: PerplexityConfig, systemPrompt: string, userPrompt: string, assistantContext?: string, signal?: AbortSignal): Promise<PerplexityConsensusResult>;
}
export interface PerplexityConsensusResult {
    best: LLMResponse;
    all: LLMResponse[];
    consensusScore: number;
    aggregate: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
        latencyMs: number;
        citations: string[];
    };
}
export declare function buildRequestBody(config: PerplexityConfig, messages: ChatMessage[]): Record<string, unknown>;
export declare class PerplexityClient implements PerplexityClientLike {
    private readonly transport;
    constructor(apiKey: string, timeoutMs?: number, transport?: ChatTransport);
    complete(config: PerplexityConfig, systemPrompt: string, userPrompt: string, assistantContext?: string, signal?: AbortSignal): Promise<LLMResponse>;
    completeWithConsensus(config: PerplexityConfig, systemPrompt: string, userPrompt: string, assistantContext?: string, signal?: AbortSignal): Promise<PerplexityConsensusResult>;
}
/** @deprecated Direct provider access bypasses router budget and circuit controls. */
export declare class PerplexityError extends ProviderRequestError {
}
//# sourceMappingURL=perplexity.d.ts.map