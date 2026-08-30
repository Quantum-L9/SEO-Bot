import { ProviderRequestError } from '../provider-errors.js';
import { type GeneralModel, type GeneralModelConfig, type LLMResponse, type VisionConfig } from '../types.js';
import { type ChatTransport } from './openai-transport.js';
export declare class UnsafeImageUrlError extends Error {
    readonly url: string;
    constructor(message: string, url: string);
    toJSON(): Record<string, unknown>;
}
export declare function validateImageUrl(url: string): void;
export interface OpenRouterClientLike {
    complete(config: GeneralModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<LLMResponse>;
    completeWithVision(config: VisionConfig, systemPrompt: string, userPrompt: string, imageUrls: string[], signal?: AbortSignal): Promise<LLMResponse>;
    completeWithFallback(config: GeneralModelConfig, fallbacks: GeneralModel[], systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<LLMResponse>;
}
export declare const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export declare class InvalidBaseUrlError extends Error {
    readonly url: string;
    readonly source: 'config' | 'env';
    constructor(message: string, url: string, source: 'config' | 'env');
    toJSON(): Record<string, unknown>;
}
/**
 * Resolves the OpenAI-compatible endpoint for the OpenRouter provider.
 *
 * Precedence: explicit config value > `OPENROUTER_BASE_URL` env var > the
 * OpenRouter cloud default. Both overrides are validated as absolute http(s)
 * URLs and normalized to strip a trailing slash so path joining stays
 * predictable. The default is returned untouched, keeping existing
 * deployments byte-for-byte identical in behavior.
 */
export declare function resolveOpenRouterBaseUrl(configured?: string, env?: Record<string, string | undefined>): string;
export declare class OpenRouterClient implements OpenRouterClientLike {
    private readonly transport;
    constructor(apiKey: string, appName?: string, timeoutMs?: number, transport?: ChatTransport, baseUrl?: string);
    complete(config: GeneralModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<LLMResponse>;
    completeWithVision(config: VisionConfig, systemPrompt: string, userPrompt: string, imageUrls: string[], signal?: AbortSignal): Promise<LLMResponse>;
    completeWithFallback(config: GeneralModelConfig, fallbacks: GeneralModel[], systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<LLMResponse>;
}
/** @deprecated Direct provider access bypasses router budget and circuit controls. */
export declare class OpenRouterError extends ProviderRequestError {
}
//# sourceMappingURL=openrouter.d.ts.map