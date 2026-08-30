const LOCAL_ERROR_NAMES = new Set([
    'TaskValidationError',
    'RouterConfigValidationError',
    'UnsafeImageUrlError',
    'BudgetExhaustedError',
    'CircuitOpenError',
    'AbortError',
]);
export class ProviderRequestError extends Error {
    provider;
    kind;
    retryable;
    status;
    code;
    requestId;
    retryAfterMs;
    cause;
    constructor(message, metadata) {
        super(message, { cause: metadata.cause });
        this.name = 'ProviderRequestError';
        this.provider = metadata.provider;
        this.kind = metadata.kind;
        this.retryable = metadata.retryable;
        this.status = metadata.status;
        this.code = metadata.code;
        this.requestId = metadata.requestId;
        this.retryAfterMs = metadata.retryAfterMs;
        this.cause = metadata.cause;
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            provider: this.provider,
            kind: this.kind,
            retryable: this.retryable,
            status: this.status,
            code: this.code,
            requestId: this.requestId,
            retryAfterMs: this.retryAfterMs,
        };
    }
}
function numberField(value, key) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}
function stringField(value, ...keys) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const record = value;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
    }
    return undefined;
}
function headerValue(error, name) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const headers = error.headers;
    if (!headers)
        return undefined;
    if (typeof headers.get === 'function') {
        const value = headers.get(name);
        return value ?? undefined;
    }
    if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string')
                return value;
        }
    }
    return undefined;
}
function retryAfterMs(error) {
    const raw = headerValue(error, 'retry-after');
    if (!raw)
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
function classifyLocalError(name) {
    if (!name || !LOCAL_ERROR_NAMES.has(name))
        return undefined;
    return { kind: name === 'AbortError' ? 'cancelled' : 'local', retryable: false };
}
function classifyByStatus(status) {
    if (status === 429)
        return { kind: 'rate_limit', retryable: true };
    if (status !== undefined && status >= 500)
        return { kind: 'server', retryable: true };
    if (status !== undefined && status >= 400)
        return { kind: 'client', retryable: false };
    return undefined;
}
function classifyByCode(code, name) {
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || name === 'TimeoutError')
        return { kind: 'timeout', retryable: true };
    if (code && ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code))
        return { kind: 'network', retryable: true };
    return undefined;
}
function classifyByMessage(message) {
    if (/timeout/i.test(message))
        return { kind: 'timeout', retryable: true };
    if (/network|socket|connection/i.test(message))
        return { kind: 'network', retryable: true };
    return undefined;
}
export function classifyProviderError(error, provider) {
    if (error instanceof ProviderRequestError)
        return error;
    const name = error instanceof Error ? error.name : stringField(error, 'name');
    const message = error instanceof Error ? error.message : String(error);
    const status = numberField(error, 'status') ?? numberField(error, 'statusCode');
    const code = stringField(error, 'code', 'type');
    const requestId = stringField(error, 'request_id', 'requestId') ?? headerValue(error, 'x-request-id');
    // Precedence is preserved from the original if/else-if chain: local error
    // names, then HTTP status, then error codes, then message heuristics.
    const { kind, retryable } = classifyLocalError(name)
        ?? classifyByStatus(status)
        ?? classifyByCode(code, name)
        ?? classifyByMessage(message)
        ?? { kind: 'unknown', retryable: false };
    return new ProviderRequestError(message, {
        provider,
        kind,
        retryable,
        status,
        code,
        requestId,
        retryAfterMs: retryAfterMs(error),
        cause: error,
    });
}
export function isCircuitFailure(error, provider) {
    const classified = classifyProviderError(error, provider);
    return classified.retryable && ['network', 'timeout', 'rate_limit', 'server'].includes(classified.kind);
}
export function throwIfAborted(signal, provider) {
    if (!signal?.aborted)
        return;
    throw new ProviderRequestError('Provider request was cancelled', {
        provider,
        kind: 'cancelled',
        retryable: false,
        code: 'ABORTED',
        cause: signal.reason,
    });
}
//# sourceMappingURL=provider-errors.js.map