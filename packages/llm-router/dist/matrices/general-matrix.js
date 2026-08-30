import { GeneralModel, Provider, TaskComplexity, TaskType, complexityRank, } from '../types.js';
import { ratePer1KOutput } from '../pricing.js';
const FAST = { model: GeneralModel.GPT4O_MINI, reason: 'Fast cost-efficient default' };
const MAP = {
    [TaskType.CLASSIFICATION]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: FAST, [TaskComplexity.MEDIUM]: FAST, [TaskComplexity.HIGH]: { model: GeneralModel.GPT4O, reason: 'Nuanced classification' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical classification' } },
    [TaskType.EXTRACTION]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: FAST, [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O, reason: 'Structured extraction' }, [TaskComplexity.HIGH]: { model: GeneralModel.GPT4O, reason: 'Complex extraction' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical extraction' } },
    [TaskType.SCORING]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: FAST, [TaskComplexity.MEDIUM]: FAST, [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Qualitative scoring' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical scoring' } },
    [TaskType.CONTENT_GENERATION]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: { model: GeneralModel.CLAUDE_HAIKU, reason: 'Short-form writing' }, [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Long-form writing' }, [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Authoritative writing' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_OPUS, reason: 'Exceptional quality' } },
    [TaskType.STRATEGIC_REASONING]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: { model: GeneralModel.GPT4O, reason: 'Basic strategy' }, [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Multi-factor strategy' }, [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Complex strategy' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.O3, reason: 'Critical multi-step reasoning' } },
    [TaskType.CODE_GENERATION]: { [TaskComplexity.TRIVIAL]: FAST, [TaskComplexity.LOW]: { model: GeneralModel.CLAUDE_HAIKU, reason: 'Small code change' }, [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Module code' }, [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Architecture-sensitive code' }, [TaskComplexity.CRITICAL]: { model: GeneralModel.O3, reason: 'Critical logic' } },
    [TaskType.COMPETITOR_RESEARCH]: {}, [TaskType.CITATION_CHECK]: {}, [TaskType.FACT_VERIFICATION]: {}, [TaskType.MARKET_RESEARCH]: {}, [TaskType.LINK_PROSPECTING]: {},
    [TaskType.VISUAL_QA]: {}, [TaskType.SCREENSHOT_ANALYSIS]: {}, [TaskType.LAYOUT_VALIDATION]: {},
};
const FALLBACKS = {
    [GeneralModel.GPT4O_MINI]: [GeneralModel.GEMINI_FLASH, GeneralModel.CLAUDE_HAIKU],
    [GeneralModel.CLAUDE_HAIKU]: [GeneralModel.GPT4O_MINI, GeneralModel.GEMINI_FLASH],
    [GeneralModel.GPT4O]: [GeneralModel.CLAUDE_SONNET, GeneralModel.GEMINI_PRO],
    [GeneralModel.CLAUDE_SONNET]: [GeneralModel.GPT4O, GeneralModel.GEMINI_PRO],
    [GeneralModel.CLAUDE_OPUS]: [GeneralModel.O3, GeneralModel.CLAUDE_SONNET],
    [GeneralModel.O1]: [GeneralModel.O3, GeneralModel.CLAUDE_SONNET],
    [GeneralModel.O3]: [GeneralModel.O1, GeneralModel.CLAUDE_OPUS],
};
export function estimateGeneralCost(model, maxTokens) {
    return Math.round((maxTokens * 2.5 / 1000) * ratePer1KOutput(model) * 100000) / 100000;
}
export function resolveGeneralConfig(task) {
    const selection = MAP[task.type]?.[task.complexity] ?? FAST;
    const maxTokens = task.expectedOutputTokens ?? (complexityRank(task.complexity) >= complexityRank(TaskComplexity.HIGH) ? 4096 : 2048);
    const responseFormat = [TaskType.CLASSIFICATION, TaskType.EXTRACTION, TaskType.SCORING].includes(task.type) ? 'json' : 'text';
    let temperature = 0.3;
    if (responseFormat === 'json')
        temperature = 0.1;
    else if (task.type === TaskType.CONTENT_GENERATION)
        temperature = 0.7;
    return { model: selection.model, provider: Provider.OPENROUTER, temperature, maxTokens, responseFormat, estimatedCostPerCall: estimateGeneralCost(selection.model, maxTokens), resolutionReason: selection.reason };
}
export function getFallbackChain(model) { return [...(FALLBACKS[model] ?? [GeneralModel.GPT4O_MINI])]; }
//# sourceMappingURL=general-matrix.js.map