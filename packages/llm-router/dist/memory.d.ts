import { type GraphitiMemoryClient, type MemoryClass } from '@quantum-l9/graphiti-memory-client';
export interface RouterMemoryConfig {
    client: GraphitiMemoryClient;
    mode?: 'optional' | 'required';
    tokenBudget?: number;
    maxRecords?: number;
    memoryClasses?: MemoryClass[];
}
export declare function hydrateRouterPrompt(config: RouterMemoryConfig | undefined, clientId: string, taskType: string, userPrompt: string): Promise<string>;
//# sourceMappingURL=memory.d.ts.map