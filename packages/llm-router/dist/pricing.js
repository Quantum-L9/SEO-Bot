import { GeneralModel } from './types.js';
export const MODEL_RATES_PER_1M = {
    [GeneralModel.GPT4O_MINI]: { input: 0.15, output: 0.6 },
    [GeneralModel.GEMINI_FLASH]: { input: 0.15, output: 0.6 },
    [GeneralModel.CLAUDE_HAIKU]: { input: 0.8, output: 4 },
    [GeneralModel.GPT4O]: { input: 2.5, output: 10 },
    [GeneralModel.CLAUDE_SONNET]: { input: 3, output: 15 },
    [GeneralModel.GEMINI_PRO]: { input: 1.25, output: 10 },
    [GeneralModel.CLAUDE_OPUS]: { input: 15, output: 75 },
    [GeneralModel.O1]: { input: 15, output: 60 },
    [GeneralModel.O3]: { input: 15, output: 60 },
};
export function ratePer1KOutput(model) { return MODEL_RATES_PER_1M[model].output / 1000; }
export function calculateOpenRouterCost(model, usage) {
    if (!usage)
        return 0;
    const rates = MODEL_RATES_PER_1M[model];
    return Math.round(((usage.prompt_tokens / 1_000_000) * rates.input + (usage.completion_tokens / 1_000_000) * rates.output) * 1_000_000) / 1_000_000;
}
//# sourceMappingURL=pricing.js.map