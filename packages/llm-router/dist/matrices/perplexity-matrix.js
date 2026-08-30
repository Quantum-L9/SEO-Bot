import { MessageStrategy, RecencyFilter, SearchContextSize, SearchMode, SonarModel, TaskComplexity, TaskType, complexityRank, } from '../types.js';
// Re-exported for backward compatibility: `isSearchTask` historically lived in
// this module. Its canonical home is now ./search-policy.ts.
export { isSearchTask } from './search-policy.js';
import { resolveSearchPolicy } from './search-policy.js';
function selectSonarModel(complexity, rank) {
    if (complexity === TaskComplexity.CRITICAL)
        return SonarModel.SONAR_DEEP_RESEARCH;
    if (rank >= complexityRank(TaskComplexity.HIGH))
        return SonarModel.SONAR_REASONING_PRO;
    if (rank >= complexityRank(TaskComplexity.MEDIUM))
        return SonarModel.SONAR_PRO;
    return SonarModel.SONAR;
}
function selectSearchContextSize(rank) {
    if (rank >= complexityRank(TaskComplexity.HIGH))
        return SearchContextSize.HIGH;
    if (rank >= complexityRank(TaskComplexity.MEDIUM))
        return SearchContextSize.MEDIUM;
    return SearchContextSize.LOW;
}
function selectVariations(complexity, rank) {
    if (complexity === TaskComplexity.CRITICAL)
        return 5;
    return rank >= complexityRank(TaskComplexity.HIGH) ? 3 : 1;
}
function selectReasoningEffort(model, complexity) {
    if (model !== SonarModel.SONAR_REASONING_PRO)
        return undefined;
    return complexity === TaskComplexity.CRITICAL ? 'high' : 'medium';
}
export function resolvePerplexityConfig(task) {
    // Provider config and routing authority must agree: a Perplexity config is
    // only ever produced for a route that resolved to search. A non-search task
    // reaching this resolver is a contract violation, not a configurable state.
    if (!resolveSearchPolicy(task).required) {
        throw new Error('resolvePerplexityConfig called for a non-search task');
    }
    const rank = complexityRank(task.complexity);
    const model = selectSonarModel(task.complexity, rank);
    const searchContextSize = selectSearchContextSize(rank);
    const maxTokens = task.expectedOutputTokens ?? (task.complexity === TaskComplexity.CRITICAL ? 4096 : 2048);
    const variations = selectVariations(task.complexity, rank);
    const estimatedCostPerCall = Math.round(maxTokens * variations * (model === SonarModel.SONAR ? 0.000001 : 0.000004) * 100000) / 100000;
    return {
        model,
        searchContextSize,
        searchMode: SearchMode.WEB,
        recencyFilter: task.recency ?? (task.type === TaskType.COMPETITOR_RESEARCH ? RecencyFilter.WEEK : RecencyFilter.NONE),
        messageStrategy: task.requiresReasoning || rank >= complexityRank(TaskComplexity.HIGH) ? MessageStrategy.SYSTEM_USER_ASSISTANT : MessageStrategy.SYSTEM_USER,
        temperature: task.type === TaskType.CONTENT_GENERATION ? 0.7 : 0.2,
        maxTokens,
        domainFilter: task.domainFilter ?? [],
        variations,
        reasoningEffort: selectReasoningEffort(model, task.complexity),
        // A Perplexity config is only ever produced for a route that resolved to
        // the search plane, so search is always on. The previous predicate
        // (`requiresSearch === false && !isSearchTask(type)`) was unreachable on
        // that route and, off-route, produced a search-provider config with search
        // disabled — a config that contradicted the decision it belonged to.
        disableSearch: false,
        estimatedCostPerCall,
        resolutionReason: `Task[${task.type}] complexity[${task.complexity}] uses ${model}`,
    };
}
//# sourceMappingURL=perplexity-matrix.js.map