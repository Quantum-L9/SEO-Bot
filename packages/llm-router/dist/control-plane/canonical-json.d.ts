export declare class CanonicalJsonError extends TypeError {
    constructor(message: string);
}
/**
 * Deterministic UTF-16 code-unit ordering — the canonical comparator used across
 * the control plane. Locale-aware comparison must never be used for canonical
 * ordering because it would make hashes non-reproducible across environments.
 */
export declare function compareCodeUnits(left: string, right: string): number;
export declare function canonicalize(value: unknown): unknown;
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(value: unknown): string;
//# sourceMappingURL=canonical-json.d.ts.map