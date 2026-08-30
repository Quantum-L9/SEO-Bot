export type MemoryClass = 'identity' | 'preference' | 'constraint' | 'decision' | 'episodic' | 'semantic' | 'procedural' | 'observation' | 'insight' | 'meta';
export interface MemoryClientConfig {
    baseUrl: string;
    bearerToken: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    idFactory?: () => string;
    protocolVersion?: string;
}
export interface ContextSection {
    memory_class: MemoryClass;
    content: string;
    record_ids: string[];
    tokens_estimated: number;
    highest_score: number;
}
export interface HydrationResult {
    receipt_id: string;
    status: 'complete' | 'partial' | 'failed';
    task: string;
    sections: ContextSection[];
    token_budget: number;
    tokens_used: number;
    search_receipt_id: string;
    result_digest: string;
    warnings: string[];
    created_at: string;
}
export interface WriteReceipt {
    receipt_id: string;
    status: 'admitted' | 'duplicate' | 'quarantined' | 'rejected' | 'superseded';
    record_id?: string | null;
    namespace: string;
    schema_version: string;
    normalized_digest: string;
    original_digest: string;
    idempotency_key: string;
    warnings: string[];
    created_at: string;
}
export interface HydrateInput {
    clientId: string;
    taskType: string;
    task: string;
    tokenBudget?: number;
    maxRecords?: number;
    entities?: string[];
    topics?: string[];
    memoryClasses?: MemoryClass[];
}
export interface MemoryWriteInput {
    clientId: string;
    content: string;
    sourceId: string;
    idempotencyKey: string;
    tags?: string[];
    confidence?: number;
    sourceTrust?: number;
    validFrom?: string;
    subject?: string;
    predicate?: string;
    object?: string;
}
export interface PromoteLearningInput {
    recordId: string;
    targetClass?: 'insight' | 'procedural' | 'semantic';
    reason: string;
    supportingRecordIds?: string[];
    testSuccessCount?: number;
    explicitConfirmation?: boolean;
    governanceApproval?: boolean;
}
interface JsonRpcErrorShape {
    code: number;
    message: string;
    data?: unknown;
}
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: string | number | null;
    result?: unknown;
    error?: JsonRpcErrorShape;
}
export declare class MemoryRpcError extends Error {
    readonly code?: number | undefined;
    readonly data?: unknown | undefined;
    readonly httpStatus?: number | undefined;
    constructor(message: string, code?: number | undefined, data?: unknown | undefined, httpStatus?: number | undefined);
}
export declare function clientMemoryNamespace(clientId: string): string;
export declare class GraphitiMemoryClient {
    private readonly endpoint;
    private readonly token;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private readonly idFactory;
    private readonly protocolVersion;
    private sessionId?;
    private initialized;
    private initializePromise?;
    constructor(config: MemoryClientConfig);
    health(): Promise<Record<string, unknown>>;
    hydrate(input: HydrateInput): Promise<HydrationResult>;
    writeDecision(input: MemoryWriteInput): Promise<WriteReceipt>;
    writeOutcome(input: MemoryWriteInput): Promise<WriteReceipt>;
    writeSemanticFact(input: MemoryWriteInput): Promise<WriteReceipt>;
    promoteLearning(input: PromoteLearningInput): Promise<Record<string, unknown>>;
    private ingest;
    private ensureSession;
    private callTool;
    private callToolOnce;
    private requestHeaders;
    private postNotification;
    private post;
    private assertEnvelope;
}
export declare function parseMcpBody(body: string, contentType: string | null): JsonRpcResponse;
export declare function renderHydration(result: HydrationResult): string;
export {};
