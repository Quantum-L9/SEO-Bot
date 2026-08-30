import { GeneralModel } from './types.js';
export interface ModelRate {
    input: number;
    output: number;
}
export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
}
export declare const MODEL_RATES_PER_1M: Record<GeneralModel, ModelRate>;
export declare function ratePer1KOutput(model: GeneralModel): number;
export declare function calculateOpenRouterCost(model: GeneralModel, usage?: TokenUsage): number;
//# sourceMappingURL=pricing.d.ts.map