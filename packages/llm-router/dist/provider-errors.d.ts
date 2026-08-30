import type { Provider, ProviderErrorMetadata, ProviderFailureKind } from './types.js';
export declare class ProviderRequestError extends Error {
    readonly provider: Provider;
    readonly kind: ProviderFailureKind;
    readonly retryable: boolean;
    readonly status?: number;
    readonly code?: string;
    readonly requestId?: string;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
    constructor(message: string, metadata: ProviderErrorMetadata);
    toJSON(): Record<string, unknown>;
}
export declare function classifyProviderError(error: unknown, provider: Provider): ProviderRequestError;
export declare function isCircuitFailure(error: unknown, provider: Provider): boolean;
export declare function throwIfAborted(signal: AbortSignal | undefined, provider: Provider): void;
//# sourceMappingURL=provider-errors.d.ts.map