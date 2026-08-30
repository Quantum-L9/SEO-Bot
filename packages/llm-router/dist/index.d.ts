import type { RouterMemoryConfig } from './memory.js';
import { BudgetReservationError, type BudgetStore } from './budget/index.js';
import { type OpenRouterClientLike } from './providers/openrouter.js';
import { type PerplexityClientLike } from './providers/perplexity.js';
import { GeneralModel, Provider, SonarModel, type BudgetConfig, type LLMResponse, type RouterConfig, type RoutingDecision, type RoutingResolution, type TaskDescriptor } from './types.js';
import { type FullSiteQAConfig, type VisualQATask } from './vision/index.js';
export interface RouterDependencies {
    clock?: () => Date;
    idFactory?: () => string;
    openrouterClient?: OpenRouterClientLike;
    perplexityClient?: PerplexityClientLike;
    budgetStore?: BudgetStore;
    memory?: RouterMemoryConfig;
}
export declare function resolveRoute(task: TaskDescriptor): RoutingResolution;
export declare function getDowngradedModel(original: GeneralModel | SonarModel, provider: Provider, maxTier: 'fast' | 'strategic' | 'critical'): GeneralModel | SonarModel;
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
export * from './types.js';
export { DEFAULT_BUDGET_CONFIG, BudgetTracker, BudgetReservationError, InMemoryBudgetStore, ThrottleLevel, evaluateBudgetAdmission, validateBudgetConfig, } from './budget/index.js';
export type { BudgetStore, GlobalBudgetState, ThrottleDecision, BudgetAdmissionInput } from './budget/index.js';
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
export { ProviderRequestError } from './provider-errors.js';
export { TaskValidationError, RouterConfigValidationError } from './schemas.js';
export { UnsafeImageUrlError, InvalidBaseUrlError, DEFAULT_OPENROUTER_BASE_URL, resolveOpenRouterBaseUrl } from './providers/openrouter.js';
export { VIEWPORTS } from './vision/index.js';
export { isSearchTask, requiresSearchProvider, resolveSearchPolicy, resolveCapabilities, resolveAndValidateCapabilities, validateCapabilities, VISION_TASKS, UnsupportedCapabilityCombinationError, } from './matrices/search-policy.js';
export type { ResolvedCapabilities, CapabilityConflictCode } from './matrices/search-policy.js';
export { hydrateRouterPrompt } from './memory.js';
export type { RouterMemoryConfig } from './memory.js';
//# sourceMappingURL=index.d.ts.map