import { SearchPolicySource, TaskType, type SearchPolicyResolution, type TaskDescriptor } from '../types.js';
/**
 * Task types whose *default* capability implies a vision-backed provider.
 *
 * This is the canonical vision-task inventory for the whole router: routing
 * and dispatch both consume it through {@link resolveCapabilities}, so no
 * other module may re-derive vision from a raw `TaskType`.
 */
export declare const VISION_TASKS: Set<TaskType>;
/**
 * Backward-compatible task-type default.
 *
 * Preserved verbatim so existing consumers that reason purely about a
 * `TaskType` keep the same answer. New routing decisions should prefer
 * {@link resolveSearchPolicy}, which honours an explicit capability flag and
 * reports *why* the answer was reached.
 */
export declare function isSearchTask(type: TaskType): boolean;
/**
 * Canonical search-policy resolver — the single implementation of the rule.
 *
 * Applications declare *whether the task needs a search provider* via
 * `TaskDescriptor.requiresSearch`. When present, that declaration is
 * authoritative and overrides the legacy per-`TaskType` default.
 *
 * This fixes the architecture leak where selecting a research-flavoured
 * `TaskType` (e.g. MARKET_RESEARCH) implied a specific provider even when the
 * caller already had normalized evidence and explicitly did not require search.
 *
 * Semantics:
 *   requiresSearch === true       -> search provider   (source EXPLICIT)
 *   requiresSearch === false      -> general provider  (source EXPLICIT)
 *   requiresSearch === undefined  -> isSearchTask(type) (source TASK_DEFAULT)
 *
 * The returned `source` is what makes an audited routing decision provable:
 * it distinguishes "the caller asked for this" from "the task type implied it".
 */
export declare function resolveSearchPolicy(task: TaskDescriptor): SearchPolicyResolution;
/**
 * Boolean view of {@link resolveSearchPolicy}. Retained as the 1.x public
 * predicate; it delegates so there is exactly one implementation of the rule.
 */
export declare function requiresSearchProvider(task: TaskDescriptor): boolean;
/**
 * The single internal capability authority.
 *
 * Routing and dispatch both consume this resolution, so a request can never
 * be interpreted one way at routing time and another way at dispatch time.
 */
export interface ResolvedCapabilities {
    /** Whether the resolved route must carry web-search capability (explicit flag or task-type default). */
    searchRequired: boolean;
    /** Where `searchRequired` came from: an explicit `TaskDescriptor.requiresSearch` boolean, or the legacy per-TaskType default. */
    searchPolicySource: SearchPolicySource;
    /** Whether the task type implies a vision-backed provider. */
    visionRequired: boolean;
    /** Whether the descriptor actually carries at least one image. */
    imagesProvided: boolean;
}
export declare function resolveCapabilities(task: TaskDescriptor): ResolvedCapabilities;
/**
 * Capability conflicts the current provider plane cannot execute faithfully.
 *
 * Every code names a combination that would otherwise degrade silently:
 *
 *   UNSUPPORTED_CAPABILITY_COMBINATION — search + vision together (legacy code)
 *   VISION_INPUT_REQUIRED               — vision task without images
 *   IMAGES_NOT_SUPPORTED_FOR_TASK       — images on a non-vision task
 *   SEARCH_MODIFIER_WITHOUT_SEARCH      — recency/domainFilter without search
 *   CONSENSUS_REQUIRES_SEARCH           — consensus on a non-search route
 */
export type CapabilityConflictCode = 'UNSUPPORTED_CAPABILITY_COMBINATION' | 'VISION_INPUT_REQUIRED' | 'IMAGES_NOT_SUPPORTED_FOR_TASK' | 'SEARCH_MODIFIER_WITHOUT_SEARCH' | 'CONSENSUS_REQUIRES_SEARCH';
/**
 * Fail-closed error for a task that asks for capabilities the router has no
 * provider contract able to satisfy faithfully.
 *
 * Raised before any budget reservation, circuit permit, or provider dispatch,
 * so an invalid request can never half-execute. This is a caller-side contract
 * error, not a provider failure: it must never count against provider circuit
 * health.
 *
 * The original `(message, requested)` constructor shape from #46 is preserved;
 * newer capability codes pass only `code` and omit `requested`.
 */
export declare class UnsupportedCapabilityCombinationError extends Error {
    readonly requested?: Readonly<{
        taskType: TaskType;
        searchRequired: boolean;
        imageCount: number;
    }> | undefined;
    readonly code: CapabilityConflictCode;
    constructor(message: string, requested?: Readonly<{
        taskType: TaskType;
        searchRequired: boolean;
        imageCount: number;
    }> | undefined, code?: CapabilityConflictCode);
    toJSON(): Record<string, unknown>;
}
/**
 * Refuses capability combinations the execution plane would silently drop.
 *
 *   vision without images  -> VISION_INPUT_REQUIRED
 *   search + vision        -> UNSUPPORTED_CAPABILITY_COMBINATION (legacy shape)
 *   images on non-vision   -> IMAGES_NOT_SUPPORTED_FOR_TASK
 *
 * Called inside route resolution before any provider/model selection, so an
 * invalid request can never reserve budget or reach dispatch.
 */
export declare function validateCapabilities(capabilities: ResolvedCapabilities, task: TaskDescriptor): void;
/**
 * Resolves capabilities and refuses every combination the provider plane
 * cannot honor, including search-only modifiers on a non-search route.
 *
 * `recency` and `domainFilter` are search execution modifiers: a general
 * route ignores them, so declaring them without search capability is an
 * explicit contract error instead of silently ignored policy.
 */
export declare function resolveAndValidateCapabilities(task: TaskDescriptor): ResolvedCapabilities;
//# sourceMappingURL=search-policy.d.ts.map