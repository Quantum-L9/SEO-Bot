import { BudgetReservationError, type BudgetStore } from "./budget/index.js";
import type { RouterMemoryConfig } from "./memory.js";
import { type OpenRouterClientLike } from "./providers/openrouter.js";
import { type PerplexityClientLike } from "./providers/perplexity.js";
import { type BudgetConfig, GeneralModel, type LLMResponse, Provider, type RouterConfig, type RoutingDecision, type RoutingResolution, SonarModel, type TaskDescriptor } from "./types.js";
import { type FullSiteQAConfig, type VisualQATask } from "./vision/index.js";
export interface RouterDependencies {
    clock?: () => Date;
    idFactory?: () => string;
    openrouterClient?: OpenRouterClientLike;
    perplexityClient?: PerplexityClientLike;
    budgetStore?: BudgetStore;
    memory?: RouterMemoryConfig;
}
export declare function resolveRoute(task: TaskDescriptor): RoutingResolution;
export declare function getDowngradedModel(original: GeneralModel | SonarModel, provider: Provider, maxTier: "fast" | "strategic" | "critical"): GeneralModel | SonarModel;
export declare class L9LLMRouter {
    private readonly budgetStore;
    private readonly localBudgetTracker?;
    private readonly circuitBreaker;
    private readonly perplexity;
    private readonly openrouter;
    private readonly clock;
    private readonly idFactory;
    private readonly callLog;
    private readonly memory?;
    constructor(config: RouterConfig, dependencies?: RouterDependencies);
    route(input: TaskDescriptor): RoutingDecision;
    execute(input: TaskDescriptor, systemPrompt: string, userPrompt: string, options?: {
        images?: string[];
        assistantContext?: string;
        consensus?: boolean;
        signal?: AbortSignal;
    }): Promise<LLMResponse>;
    private dispatchProvider;
    private toExecutionError;
    initClient(clientId: string, overrides?: Partial<BudgetConfig>): Promise<void>;
    resetDaily(clientId: string): Promise<void>;
    resetWeekly(clientId: string): Promise<void>;
    resetMonthly(clientId: string): Promise<void>;
    resetGlobalMonthly(): Promise<void>;
    checkSurge(clientId: string, dayOfWeek?: number): Promise<boolean>;
    getClientBudgetReport(clientId: string): import("./types.js").BudgetState;
    getAllBudgetReports(): import("./types.js").BudgetState[];
    getGlobalSpend(): import("./budget/index.js").GlobalBudgetState;
    getClientBudgetReportAsync(clientId: string): Promise<import("./types.js").BudgetState>;
    getAllBudgetReportsAsync(): Promise<import("./types.js").BudgetState[]>;
    getGlobalSpendAsync(): Promise<import("./budget/index.js").GlobalBudgetState>;
    getCircuitState(provider: Provider): import("./types.js").CircuitBreakerState;
    getCallLog(limit?: number): RoutingDecision[];
    getCallLogByClient(clientId: string, limit?: number): RoutingDecision[];
    planVisualQA(config: FullSiteQAConfig): VisualQATask[];
    getViewports(): Record<string, import("./vision/index.js").ViewportConfig>;
}
export declare class BudgetExhaustedError extends Error {
    readonly task: TaskDescriptor;
    readonly decision: RoutingDecision;
    readonly cause: BudgetReservationError;
    constructor(message: string, task: TaskDescriptor, decision: RoutingDecision, cause: BudgetReservationError);
}
export type { BudgetAdmissionInput, BudgetStore, GlobalBudgetState, ThrottleDecision, } from "./budget/index.js";
export { BudgetReservationError, BudgetTracker, DEFAULT_BUDGET_CONFIG, evaluateBudgetAdmission, InMemoryBudgetStore, ThrottleLevel, validateBudgetConfig, } from "./budget/index.js";
export { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
export type { CapabilityConflictCode, ResolvedCapabilities } from "./matrices/search-policy.js";
export { isSearchTask, requiresSearchProvider, resolveAndValidateCapabilities, resolveCapabilities, resolveSearchPolicy, UnsupportedCapabilityCombinationError, VISION_TASKS, validateCapabilities, } from "./matrices/search-policy.js";
export type { RouterMemoryConfig } from "./memory.js";
export { hydrateRouterPrompt } from "./memory.js";
export { ProviderRequestError } from "./provider-errors.js";
export { DEFAULT_OPENROUTER_BASE_URL, InvalidBaseUrlError, resolveOpenRouterBaseUrl, UnsafeImageUrlError, } from "./providers/openrouter.js";
export { RouterConfigValidationError, TaskValidationError } from "./schemas.js";
export * from "./types.js";
export { VIEWPORTS } from "./vision/index.js";
//# sourceMappingURL=index.d.ts.map
