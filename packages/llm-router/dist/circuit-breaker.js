export const DEFAULT_CIRCUIT_BREAKER_CONFIG = Object.freeze({
    failureThreshold: 5,
    openDurationMs: 30_000,
});
export class CircuitOpenError extends Error {
    provider;
    constructor(provider) {
        super(`Circuit breaker is open for provider "${provider}"; dispatch refused.`);
        this.provider = provider;
        this.name = 'CircuitOpenError';
    }
}
export class CircuitBreaker {
    config;
    states = new Map();
    legacyHalfOpenPermits = new Map();
    constructor(config = {}) {
        this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
        if (!Number.isInteger(this.config.failureThreshold) || this.config.failureThreshold <= 0) {
            throw new RangeError('failureThreshold must be a positive integer');
        }
        if (!Number.isInteger(this.config.openDurationMs) || this.config.openDurationMs <= 0) {
            throw new RangeError('openDurationMs must be a positive integer');
        }
    }
    acquire(provider, now = new Date()) {
        const state = this.getOrInit(provider);
        if (state.state === 'closed')
            return { provider, halfOpenProbe: false, acquiredAt: now };
        if (state.state === 'open') {
            if (!state.nextRetryAt || now < state.nextRetryAt)
                throw new CircuitOpenError(provider);
            state.state = 'half-open';
            state.probeInFlight = true;
            return { provider, halfOpenProbe: true, acquiredAt: now };
        }
        if (state.probeInFlight)
            throw new CircuitOpenError(provider);
        state.probeInFlight = true;
        return { provider, halfOpenProbe: true, acquiredAt: now };
    }
    canProceed(provider, now = new Date()) {
        try {
            const permit = this.acquire(provider, now);
            if (permit.halfOpenProbe)
                this.legacyHalfOpenPermits.set(provider, permit);
            return true;
        }
        catch (error) {
            if (error instanceof CircuitOpenError)
                return false;
            throw error;
        }
    }
    recordSuccess(permit) {
        const state = this.getOrInit(permit.provider);
        if (!permit.halfOpenProbe && state.state !== 'closed')
            return;
        state.state = 'closed';
        state.failureCount = 0;
        state.lastFailure = undefined;
        state.nextRetryAt = undefined;
        state.probeInFlight = false;
    }
    recordFailure(permit, now = new Date()) {
        const state = this.getOrInit(permit.provider);
        if (!permit.halfOpenProbe && state.state !== 'closed')
            return;
        state.failureCount += 1;
        state.lastFailure = now;
        state.probeInFlight = false;
        if (permit.halfOpenProbe || state.failureCount >= this.config.failureThreshold) {
            state.state = 'open';
            state.nextRetryAt = new Date(now.getTime() + this.config.openDurationMs);
        }
    }
    /** Releases a permit after a non-provider failure or cancellation. */
    release(permit, now = new Date()) {
        if (!permit.halfOpenProbe)
            return;
        const state = this.getOrInit(permit.provider);
        state.probeInFlight = false;
        state.state = 'open';
        state.nextRetryAt = new Date(now.getTime() + this.config.openDurationMs);
    }
    /** Backward-compatible direct success API. */
    recordProviderSuccess(provider) {
        const permit = this.legacyHalfOpenPermits.get(provider) ?? { provider, halfOpenProbe: false, acquiredAt: new Date() };
        this.legacyHalfOpenPermits.delete(provider);
        this.recordSuccess(permit);
    }
    /** Backward-compatible direct failure API. */
    recordProviderFailure(provider, now = new Date()) {
        const permit = this.legacyHalfOpenPermits.get(provider) ?? { provider, halfOpenProbe: false, acquiredAt: now };
        this.legacyHalfOpenPermits.delete(provider);
        this.recordFailure(permit, now);
    }
    getState(provider) {
        return cloneState(this.getOrInit(provider));
    }
    getAllStates() {
        return Array.from(this.states.values(), cloneState);
    }
    getOrInit(provider) {
        let state = this.states.get(provider);
        if (!state) {
            state = { provider, state: 'closed', failureCount: 0, probeInFlight: false };
            this.states.set(provider, state);
        }
        return state;
    }
}
function cloneState(state) {
    return {
        ...state,
        lastFailure: state.lastFailure ? new Date(state.lastFailure) : undefined,
        nextRetryAt: state.nextRetryAt ? new Date(state.nextRetryAt) : undefined,
    };
}
//# sourceMappingURL=circuit-breaker.js.map