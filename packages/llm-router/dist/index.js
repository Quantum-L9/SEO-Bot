import { randomUUID } from 'node:crypto';
import { hydrateRouterPrompt } from './memory.js';
import { BudgetReservationError, BudgetTracker, InMemoryBudgetStore, } from './budget/index.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { resolveGeneralConfig, getFallbackChain } from './matrices/general-matrix.js';
import { resolvePerplexityConfig } from './matrices/perplexity-matrix.js';
import { resolveAndValidateCapabilities, UnsupportedCapabilityCombinationError } from './matrices/search-policy.js';
import { classifyProviderError, isCircuitFailure } from './provider-errors.js';
import { OpenRouterClient, validateImageUrl } from './providers/openrouter.js';
import { PerplexityClient } from './providers/perplexity.js';
import { parseExecutableTaskDescriptor, parseRouterConfig, parseTaskDescriptor } from './schemas.js';
import { GeneralModel, Provider, SonarModel, } from './types.js';
import { generateFullSiteQAPlan, resolveVisionConfig, VIEWPORTS } from './vision/index.js';
export function resolveRoute(task) {
    // One capability decision for the whole call: routing and dispatch both
    // consume this resolution, so a request can never be interpreted one way
    // at routing time and another way at dispatch time. Validation refuses
    // every combination the provider plane would silently drop.
    const capabilities = resolveAndValidateCapabilities(task);
    const audit = {
        taskType: task.type,
        complexity: task.complexity,
        searchRequired: capabilities.searchRequired,
        searchPolicySource: capabilities.searchPolicySource,
        visionRequired: capabilities.visionRequired,
    };
    if (capabilities.searchRequired) {
        const config = resolvePerplexityConfig(task);
        return { ...audit, provider: Provider.PERPLEXITY, model: config.model, estimatedCost: config.estimatedCostPerCall, reason: config.resolutionReason };
    }
    if (capabilities.visionRequired) {
        // Validation guarantees at least one image on a vision route.
        const config = resolveVisionConfig(task.type, task.complexity, task.images.length);
        return { ...audit, provider: Provider.OPENROUTER, model: config.model, estimatedCost: config.estimatedCostPerCall, reason: config.resolutionReason };
    }
    const config = resolveGeneralConfig(task);
    return { ...audit, provider: Provider.OPENROUTER, model: config.model, estimatedCost: config.estimatedCostPerCall, reason: config.resolutionReason };
}
export function getDowngradedModel(original, provider, maxTier) {
    if (maxTier === 'critical')
        return original;
    if (provider === Provider.PERPLEXITY) {
        if (maxTier === 'fast')
            return SonarModel.SONAR;
        return original === SonarModel.SONAR_DEEP_RESEARCH ? SonarModel.SONAR_REASONING_PRO : original;
    }
    if (maxTier === 'fast')
        return GeneralModel.GPT4O_MINI;
    return [GeneralModel.CLAUDE_OPUS, GeneralModel.O1, GeneralModel.O3].includes(original) ? GeneralModel.CLAUDE_SONNET : original;
}
export class L9LLMRouter {
    budgetStore;
    localBudgetTracker;
    circuitBreaker;
    perplexity;
    openrouter;
    clock;
    idFactory;
    callLog = [];
    memory;
    constructor(config, dependencies = {}) {
        const validated = parseRouterConfig(config);
        if (dependencies.budgetStore) {
            this.budgetStore = dependencies.budgetStore;
        }
        else {
            this.localBudgetTracker = new BudgetTracker(validated.budget);
            this.budgetStore = new InMemoryBudgetStore(this.localBudgetTracker);
        }
        this.circuitBreaker = new CircuitBreaker(validated.circuitBreaker);
        this.clock = dependencies.clock ?? (() => new Date());
        this.idFactory = dependencies.idFactory ?? randomUUID;
        this.perplexity = dependencies.perplexityClient ?? new PerplexityClient(validated.perplexityApiKey, validated.providerTimeoutMs);
        this.memory = dependencies.memory;
        this.openrouter = dependencies.openrouterClient ?? new OpenRouterClient(validated.openrouterApiKey, validated.appName, validated.providerTimeoutMs, undefined, validated.openrouterBaseUrl);
    }
    route(input) {
        const task = parseTaskDescriptor(input);
        const resolution = resolveRoute(task);
        return { ...resolution, taskId: this.idFactory(), clientId: task.clientId ?? 'default', timestamp: this.clock().toISOString() };
    }
    async execute(input, systemPrompt, userPrompt, options) {
        const parsedTask = parseExecutableTaskDescriptor(input);
        const task = options?.images === undefined ? parsedTask : parseExecutableTaskDescriptor({ ...parsedTask, images: options.images });
        const images = task.images;
        if (images)
            for (const image of images)
                validateImageUrl(image);
        const decision = this.route(task);
        // Consensus is a search execution modifier, not hidden routing authority:
        // a non-search route would silently ignore it, so refuse the combination
        // before any budget reservation.
        if (options?.consensus && !decision.searchRequired) {
            throw new UnsupportedCapabilityCombinationError('Consensus requires a search-backed route', undefined, 'CONSENSUS_REQUIRES_SEARCH');
        }
        const governedMemory = await hydrateRouterPrompt(this.memory, decision.clientId, task.type, userPrompt);
        const effectiveSystemPrompt = governedMemory ? `${systemPrompt}${governedMemory}` : systemPrompt;
        let reservationId;
        let permit;
        let providerCompleted = false;
        try {
            const { decision: throttle, reservation } = await this.budgetStore.reserveTask(task.clientId, task, decision.estimatedCost, this.clock(), this.idFactory);
            reservationId = reservation.id;
            if (throttle.forceDowngrade) {
                decision.downgraded = true;
                decision.downgradedFrom = decision.model;
                decision.model = getDowngradedModel(decision.model, decision.provider, throttle.maxModelTier);
            }
            permit = this.circuitBreaker.acquire(decision.provider, this.clock());
            const response = await this.dispatchProvider(task, decision, effectiveSystemPrompt, userPrompt, images, options);
            providerCompleted = true;
            this.circuitBreaker.recordSuccess(permit);
            await this.budgetStore.reconcile(reservationId, response.cost);
            reservationId = undefined;
            decision.actualCost = response.cost;
            decision.latencyMs = response.latencyMs;
            decision.outcome = 'SUCCESS';
            this.callLog.push(decision);
            return response;
        }
        catch (error) {
            // Before provider completion, release an unbilled reservation. After a
            // provider response, retain it if reconciliation fails so durable budget
            // state remains fail-closed and can be repaired instead of forgetting cost.
            if (reservationId && !providerCompleted)
                await this.budgetStore.release(reservationId);
            if (permit) {
                if (isCircuitFailure(error, decision.provider))
                    this.circuitBreaker.recordFailure(permit, this.clock());
                else
                    this.circuitBreaker.release(permit, this.clock());
            }
            // Failed routed calls are auditable too: record the classified failure
            // on the decision before rethrowing. Prompt, keys, and image contents
            // never enter the call log.
            const classified = classifyProviderError(error, decision.provider);
            decision.outcome = 'FAILED';
            decision.failureKind = classified.kind;
            decision.errorCode = classified.code ?? (error instanceof Error ? error.name : undefined);
            this.callLog.push(decision);
            if (providerCompleted)
                throw error;
            throw this.toExecutionError(error, task, decision);
        }
    }
    dispatchProvider(task, decision, effectiveSystemPrompt, userPrompt, images, options) {
        // Dispatch consumes the resolved decision — it never re-derives the plane
        // from the raw task. The audited decision and the plane about to be
        // dispatched must agree in both directions: a search decision may not
        // execute on the general plane, and a non-search decision may not execute
        // web search. Perplexity is the router's only search-capable provider.
        if (decision.searchRequired !== (decision.provider === Provider.PERPLEXITY)) {
            throw new Error(`Routing decision searchRequired=${decision.searchRequired} disagrees with provider ${decision.provider}`);
        }
        if (decision.searchRequired) {
            if (decision.provider !== Provider.PERPLEXITY)
                throw new Error('Search decision resolved a non-Perplexity provider');
            const config = resolvePerplexityConfig(task);
            if (!Object.values(SonarModel).includes(decision.model))
                throw new Error('Perplexity route resolved a non-Sonar model');
            // A search route may never dispatch a config that turns search off.
            if (config.disableSearch)
                throw new Error('Search route resolved a Perplexity config with search disabled');
            config.model = decision.model;
            if (options?.consensus && config.variations > 1) {
                return this.perplexity.completeWithConsensus(config, effectiveSystemPrompt, userPrompt, options.assistantContext, options.signal).then(consensus => ({
                    ...consensus.best,
                    inputTokens: consensus.aggregate.inputTokens,
                    outputTokens: consensus.aggregate.outputTokens,
                    totalTokens: consensus.aggregate.totalTokens,
                    cost: consensus.aggregate.cost,
                    latencyMs: consensus.aggregate.latencyMs,
                    citations: consensus.aggregate.citations,
                }));
            }
            return this.perplexity.complete(config, effectiveSystemPrompt, userPrompt, options?.assistantContext, options?.signal);
        }
        if (decision.visionRequired) {
            if (decision.provider !== Provider.OPENROUTER)
                throw new Error('Vision decision resolved a non-OpenRouter provider');
            if (!images || images.length === 0)
                throw new Error('Vision route dispatched without images');
            const config = resolveVisionConfig(task.type, task.complexity, images.length);
            config.model = decision.model;
            return this.openrouter.completeWithVision(config, effectiveSystemPrompt, userPrompt, images, options?.signal);
        }
        const config = resolveGeneralConfig(task);
        config.model = decision.model;
        return this.openrouter.completeWithFallback(config, getFallbackChain(config.model), effectiveSystemPrompt, userPrompt, options?.signal);
    }
    toExecutionError(error, task, decision) {
        if (error instanceof BudgetReservationError)
            return new BudgetExhaustedError(error.message, task, decision, error);
        if (error instanceof CircuitOpenError)
            return error;
        if (error instanceof Error && ['TaskValidationError', 'UnsafeImageUrlError'].includes(error.name))
            return error;
        return classifyProviderError(error, decision.provider);
    }
    initClient(clientId, overrides) { return this.budgetStore.initClient(clientId, overrides); }
    resetDaily(clientId) { return this.budgetStore.resetDaily(clientId); }
    resetWeekly(clientId) { return this.budgetStore.resetWeekly(clientId); }
    resetMonthly(clientId) { return this.budgetStore.resetMonthly(clientId); }
    resetGlobalMonthly() { return this.budgetStore.resetGlobalMonthly(); }
    checkSurge(clientId, dayOfWeek = this.clock().getDay()) { return this.budgetStore.checkSurgeAllowance(clientId, dayOfWeek); }
    getClientBudgetReport(clientId) {
        if (!this.localBudgetTracker)
            throw new Error('Synchronous budget reports are unavailable with an external BudgetStore; use getClientBudgetReportAsync()');
        return this.localBudgetTracker.getClientBudgetReport(clientId);
    }
    getAllBudgetReports() {
        if (!this.localBudgetTracker)
            throw new Error('Synchronous budget reports are unavailable with an external BudgetStore; use getAllBudgetReportsAsync()');
        return this.localBudgetTracker.getAllBudgetReports();
    }
    getGlobalSpend() {
        if (!this.localBudgetTracker)
            throw new Error('Synchronous budget reports are unavailable with an external BudgetStore; use getGlobalSpendAsync()');
        return this.localBudgetTracker.getGlobalSpend();
    }
    getClientBudgetReportAsync(clientId) { return this.budgetStore.getClientBudgetReport(clientId); }
    getAllBudgetReportsAsync() { return this.budgetStore.getAllBudgetReports(); }
    getGlobalSpendAsync() { return this.budgetStore.getGlobalSpend(); }
    getCircuitState(provider) { return this.circuitBreaker.getState(provider); }
    getCallLog(limit = 100) { return this.callLog.slice(-limit).map(entry => ({ ...entry })); }
    getCallLogByClient(clientId, limit = 50) { return this.callLog.filter(entry => entry.clientId === clientId).slice(-limit).map(entry => ({ ...entry })); }
    planVisualQA(config) { return generateFullSiteQAPlan(config); }
    getViewports() { return VIEWPORTS; }
}
export class BudgetExhaustedError extends Error {
    task;
    decision;
    cause;
    constructor(message, task, decision, cause) {
        super(message, { cause });
        this.task = task;
        this.decision = decision;
        this.name = 'BudgetExhaustedError';
        this.cause = cause;
    }
}
export * from './types.js';
export { DEFAULT_BUDGET_CONFIG, BudgetTracker, BudgetReservationError, InMemoryBudgetStore, ThrottleLevel, evaluateBudgetAdmission, validateBudgetConfig, } from './budget/index.js';
export { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
export { ProviderRequestError } from './provider-errors.js';
export { TaskValidationError, RouterConfigValidationError } from './schemas.js';
export { UnsafeImageUrlError, InvalidBaseUrlError, DEFAULT_OPENROUTER_BASE_URL, resolveOpenRouterBaseUrl } from './providers/openrouter.js';
export { VIEWPORTS } from './vision/index.js';
export { isSearchTask, requiresSearchProvider, resolveSearchPolicy, resolveCapabilities, resolveAndValidateCapabilities, validateCapabilities, VISION_TASKS, UnsupportedCapabilityCombinationError, } from './matrices/search-policy.js';
export { hydrateRouterPrompt } from './memory.js';
//# sourceMappingURL=index.js.map