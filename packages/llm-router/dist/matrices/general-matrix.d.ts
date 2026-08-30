import { GeneralModel, type GeneralModelConfig, type TaskDescriptor } from '../types.js';
export declare function estimateGeneralCost(model: GeneralModel, maxTokens: number): number;
export declare function resolveGeneralConfig(task: TaskDescriptor): GeneralModelConfig;
export declare function getFallbackChain(model: GeneralModel): GeneralModel[];
//# sourceMappingURL=general-matrix.d.ts.map