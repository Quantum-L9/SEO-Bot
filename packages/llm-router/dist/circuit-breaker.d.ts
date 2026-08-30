import type { CircuitBreakerConfig, CircuitBreakerState, Provider } from './types.js';
export declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
export interface CircuitPermit {
    readonly provider: Provider;
    readonly halfOpenProbe: boolean;
    readonly acquiredAt: Date;
}
export declare class CircuitOpenError extends Error {
    readonly provider: Provider;
    constructor(provider: Provider);
}
export declare class CircuitBreaker {
    private readonly config;
    private readonly states;
    private readonly legacyHalfOpenPermits;
    constructor(config?: Partial<CircuitBreakerConfig>);
    acquire(provider: Provider, now?: Date): CircuitPermit;
    canProceed(provider: Provider, now?: Date): boolean;
    recordSuccess(permit: CircuitPermit): void;
    recordFailure(permit: CircuitPermit, now?: Date): void;
    /** Releases a permit after a non-provider failure or cancellation. */
    release(permit: CircuitPermit, now?: Date): void;
    /** Backward-compatible direct success API. */
    recordProviderSuccess(provider: Provider): void;
    /** Backward-compatible direct failure API. */
    recordProviderFailure(provider: Provider, now?: Date): void;
    getState(provider: Provider): CircuitBreakerState;
    getAllStates(): CircuitBreakerState[];
    private getOrInit;
}
//# sourceMappingURL=circuit-breaker.d.ts.map