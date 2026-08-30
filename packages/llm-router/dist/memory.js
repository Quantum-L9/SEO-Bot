import { renderHydration } from '@quantum-l9/graphiti-memory-client';
export async function hydrateRouterPrompt(config, clientId, taskType, userPrompt) {
    if (!config)
        return '';
    try {
        const result = await config.client.hydrate({ clientId, taskType, task: userPrompt, tokenBudget: config.tokenBudget, maxRecords: config.maxRecords, memoryClasses: config.memoryClasses });
        return renderHydration(result);
    }
    catch (error) {
        if ((config.mode ?? 'optional') === 'required')
            throw error;
        return '';
    }
}
//# sourceMappingURL=memory.js.map