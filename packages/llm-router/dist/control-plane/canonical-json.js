import { createHash } from 'node:crypto';
export class CanonicalJsonError extends TypeError {
    constructor(message) { super(message); this.name = 'CanonicalJsonError'; }
}
function isPlainObject(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
/**
 * Deterministic UTF-16 code-unit ordering — the canonical comparator used across
 * the control plane. Locale-aware comparison must never be used for canonical
 * ordering because it would make hashes non-reproducible across environments.
 */
export function compareCodeUnits(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function normalizeArray(value, stack, path) {
    for (let index = 0; index < value.length; index += 1)
        if (!(index in value))
            throw new CanonicalJsonError(`${path}[${index}]: sparse arrays are forbidden`);
    return value.map((entry, index) => normalize(entry, stack, `${path}[${index}]`));
}
function normalizeObject(value, stack, path) {
    if (!isPlainObject(value))
        throw new CanonicalJsonError(`${path}: only plain objects are canonicalizable`);
    if (Object.getOwnPropertySymbols(value).length > 0)
        throw new CanonicalJsonError(`${path}: symbol properties are forbidden`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalizedEntries = Object.keys(descriptors).map(key => {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || descriptor.get || descriptor.set)
            throw new CanonicalJsonError(`${path}.${key}: accessors and non-enumerable properties are forbidden`);
        return { originalKey: key, key: key.normalize('NFC'), value: descriptor.value };
    });
    const seen = new Set();
    for (const entry of normalizedEntries) {
        if (seen.has(entry.key))
            throw new CanonicalJsonError(`${path}: Unicode-normalized duplicate key "${entry.key}"`);
        seen.add(entry.key);
    }
    normalizedEntries.sort((left, right) => compareCodeUnits(left.key, right.key));
    const result = {};
    for (const entry of normalizedEntries)
        result[entry.key] = normalize(entry.value, stack, `${path}.${entry.originalKey}`);
    return result;
}
function normalize(value, stack, path) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return typeof value === 'string' ? value.normalize('NFC') : value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new CanonicalJsonError(`${path}: non-finite numbers are forbidden`);
        return Object.is(value, -0) ? 0 : value;
    }
    if (['undefined', 'bigint', 'symbol', 'function'].includes(typeof value))
        throw new CanonicalJsonError(`${path}: unsupported ${typeof value} value`);
    if (typeof value !== 'object')
        throw new CanonicalJsonError(`${path}: unsupported value`);
    if (stack.has(value))
        throw new CanonicalJsonError(`${path}: cyclic value`);
    stack.add(value);
    try {
        return Array.isArray(value) ? normalizeArray(value, stack, path) : normalizeObject(value, stack, path);
    }
    finally {
        stack.delete(value);
    }
}
export function canonicalize(value) { return normalize(value, new Set(), '$'); }
export function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
export function sha256Hex(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
//# sourceMappingURL=canonical-json.js.map