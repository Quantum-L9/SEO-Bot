/** Core public contracts for the legacy L9 router. */
export declare enum Provider {
    OPENROUTER = "openrouter",
    PERPLEXITY = "perplexity",
    OPENAI_DIRECT = "openai_direct",
    ANTHROPIC_DIRECT = "anthropic_direct"
}
export declare enum SonarModel {
    SONAR = "sonar",
    SONAR_PRO = "sonar-pro",
    SONAR_REASONING = "sonar-reasoning",
    SONAR_REASONING_PRO = "sonar-reasoning-pro",
    SONAR_DEEP_RESEARCH = "sonar-deep-research"
}
export declare enum GeneralModel {
    GPT4O_MINI = "openai/gpt-4o-mini",
    GEMINI_FLASH = "google/gemini-2.5-flash",
    CLAUDE_HAIKU = "anthropic/claude-haiku-4.5",
    GPT4O = "openai/gpt-4o",
    CLAUDE_SONNET = "anthropic/claude-sonnet-4",
    GEMINI_PRO = "google/gemini-2.5-pro",
    CLAUDE_OPUS = "anthropic/claude-opus-4",
    O1 = "openai/o1",
    O3 = "openai/o3",
    GPT4O_VISION = "openai/gpt-4o",
    CLAUDE_SONNET_VISION = "anthropic/claude-sonnet-4",
    GEMINI_FLASH_VISION = "google/gemini-2.5-flash"
}
/**
 * Why a routing decision required (or did not require) a search provider.
 *
 * EXPLICIT     — the caller set `TaskDescriptor.requiresSearch` to a boolean.
 * TASK_DEFAULT — the caller left it undefined, so the `TaskType` default applied.
 */
export declare enum SearchPolicySource {
    EXPLICIT = "explicit",
    TASK_DEFAULT = "task_default"
}
export interface SearchPolicyResolution {
    required: boolean;
    source: SearchPolicySource;
}
export declare enum SearchContextSize {
    LOW = "low",
    MEDIUM = "medium",
    HIGH = "high"
}
export declare enum SearchMode {
    WEB = "web",
    ACADEMIC = "academic",
    SEC = "sec"
}
export declare enum RecencyFilter {
    HOUR = "hour",
    DAY = "day",
    WEEK = "week",
    MONTH = "month",
    YEAR = "year",
    NONE = "none"
}
export declare enum MessageStrategy {
    SYSTEM_USER = "system_user",
    SYSTEM_USER_ASSISTANT = "system_user_asst"
}
export declare enum TaskComplexity {
    TRIVIAL = "trivial",
    LOW = "low",
    MEDIUM = "medium",
    HIGH = "high",
    CRITICAL = "critical"
}
export declare const TASK_COMPLEXITY_RANK: Readonly<Record<TaskComplexity, number>>;
export declare function complexityRank(value: TaskComplexity): number;
export declare enum TaskType {
    CLASSIFICATION = "classification",
    EXTRACTION = "extraction",
    SCORING = "scoring",
    CONTENT_GENERATION = "content_generation",
    STRATEGIC_REASONING = "strategic_reasoning",
    CODE_GENERATION = "code_generation",
    COMPETITOR_RESEARCH = "competitor_research",
    CITATION_CHECK = "citation_check",
    FACT_VERIFICATION = "fact_verification",
    MARKET_RESEARCH = "market_research",
    LINK_PROSPECTING = "link_prospecting",
    VISUAL_QA = "visual_qa",
    SCREENSHOT_ANALYSIS = "screenshot_analysis",
    LAYOUT_VALIDATION = "layout_validation"
}
export interface PerplexityConfig {
    model: SonarModel;
    searchContextSize: SearchContextSize;
    searchMode: SearchMode;
    recencyFilter: RecencyFilter;
    messageStrategy: MessageStrategy;
    temperature: number;
    maxTokens: number;
    domainFilter: string[];
    variations: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
    disableSearch: boolean;
    estimatedCostPerCall: number;
    resolutionReason: string;
}
export interface GeneralModelConfig {
    model: GeneralModel;
    provider: Provider;
    temperature: number;
    maxTokens: number;
    responseFormat?: 'json' | 'text';
    estimatedCostPerCall: number;
    resolutionReason: string;
}
export interface VisionConfig {
    model: GeneralModel;
    provider: Provider;
    maxTokens: number;
    detail: 'low' | 'high' | 'auto';
    estimatedCostPerCall: number;
    resolutionReason: string;
}
export interface TaskDescriptor {
    type: TaskType;
    complexity: TaskComplexity;
    expectedOutputTokens?: number;
    requiresReasoning?: boolean;
    requiresSearch?: boolean;
    recency?: RecencyFilter;
    domainFilter?: string[];
    images?: string[];
    viewport?: 'desktop' | 'mobile';
    clientId?: string;
    description?: string;
}
export interface BudgetState {
    clientId: string;
    monthlyBudget: number;
    monthSpend: number;
    weekSpend: number;
    weekTarget: number;
    todaySpend: number;
    weeklyHardCeiling: number;
    surgeAllowance: boolean;
    remainingMonthly: number;
    remainingWeekly: number;
    throttleLevel: 'none' | 'soft' | 'hard';
    reservedSpend: number;
    activeReservations: number;
}
export interface BudgetConfig {
    monthlyBudgetPerClient: number;
    weeklyTarget: number;
    weeklyHardCeiling: number;
    globalMonthlyHardCeiling: number;
    surgeThreshold: number;
}
export interface BudgetReservation {
    id: string;
    clientId: string;
    estimatedCost: number;
    createdAt: string;
}
export interface LLMResponse {
    content: string;
    model: string;
    provider: Provider;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    latencyMs: number;
    cached: boolean;
    citations?: string[];
    searchResults?: Record<string, unknown>[];
    requestId?: string;
    finishReason?: string;
}
export interface RouterConfig {
    perplexityApiKey: string;
    openrouterApiKey: string;
    /**
     * OpenAI-compatible endpoint for the OpenRouter provider. Defaults to
     * `https://openrouter.ai/api/v1`; may also be supplied via the
     * `OPENROUTER_BASE_URL` environment variable (explicit config wins over env).
     * Enables gateways, proxies, and self-hosted OpenAI-compatible backends
     * without code changes. Existing deployments are unaffected.
     */
    openrouterBaseUrl?: string;
    appName?: string;
    budget?: Partial<BudgetConfig>;
    circuitBreaker?: Partial<CircuitBreakerConfig>;
    providerTimeoutMs?: number;
    /** Must remain zero so every provider attempt is visible to router accounting. */
    providerMaxRetries?: 0;
}
export interface RoutingResolution {
    taskType: TaskType;
    complexity: TaskComplexity;
    provider: Provider;
    model: GeneralModel | SonarModel;
    estimatedCost: number;
    reason: string;
    /** Whether this decision resolved to a search-capable provider plane. */
    searchRequired: boolean;
    /** Whether `searchRequired` came from the caller or from the TaskType default. */
    searchPolicySource: SearchPolicySource;
    /** Whether the task type implies a vision-backed provider. Dispatch consumes this instead of re-deriving vision from the task. */
    visionRequired: boolean;
}
export interface RoutingDecision extends RoutingResolution {
    taskId: string;
    clientId: string;
    actualCost?: number;
    latencyMs?: number;
    timestamp: string;
    downgraded?: boolean;
    downgradedFrom?: GeneralModel | SonarModel;
    /** Terminal state of the routed call. Set to SUCCESS on provider completion; FAILED when the call fails after route resolution. */
    outcome?: 'SUCCESS' | 'FAILED';
    /** Classification of a failed routed call. Never carries prompts, keys, or image contents. */
    failureKind?: ProviderFailureKind;
    /** Provider error code, or the error name for local policy failures. */
    errorCode?: string;
}
export interface CircuitBreakerState {
    provider: Provider;
    state: 'closed' | 'open' | 'half-open';
    failureCount: number;
    lastFailure?: Date;
    nextRetryAt?: Date;
    probeInFlight: boolean;
}
export interface CircuitBreakerConfig {
    failureThreshold: number;
    openDurationMs: number;
}
export type ProviderFailureKind = 'network' | 'timeout' | 'rate_limit' | 'server' | 'client' | 'cancelled' | 'local' | 'unknown';
export interface ProviderErrorMetadata {
    provider: Provider;
    kind: ProviderFailureKind;
    retryable: boolean;
    status?: number;
    code?: string;
    requestId?: string;
    retryAfterMs?: number;
    cause?: unknown;
}
//# sourceMappingURL=types.d.ts.map