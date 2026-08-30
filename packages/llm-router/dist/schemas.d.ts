import { z } from 'zod';
import { RecencyFilter, TaskComplexity, TaskType, type RouterConfig, type TaskDescriptor } from './types.js';
export declare const TaskDescriptorSchema: z.ZodObject<{
    type: z.ZodEnum<typeof TaskType>;
    complexity: z.ZodEnum<typeof TaskComplexity>;
    expectedOutputTokens: z.ZodOptional<z.ZodNumber>;
    requiresReasoning: z.ZodOptional<z.ZodBoolean>;
    requiresSearch: z.ZodOptional<z.ZodBoolean>;
    recency: z.ZodOptional<z.ZodEnum<typeof RecencyFilter>>;
    domainFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
    images: z.ZodOptional<z.ZodArray<z.ZodString>>;
    viewport: z.ZodOptional<z.ZodEnum<{
        desktop: "desktop";
        mobile: "mobile";
    }>>;
    clientId: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ExecutableTaskDescriptorSchema: z.ZodObject<{
    type: z.ZodEnum<typeof TaskType>;
    complexity: z.ZodEnum<typeof TaskComplexity>;
    expectedOutputTokens: z.ZodOptional<z.ZodNumber>;
    requiresReasoning: z.ZodOptional<z.ZodBoolean>;
    requiresSearch: z.ZodOptional<z.ZodBoolean>;
    recency: z.ZodOptional<z.ZodEnum<typeof RecencyFilter>>;
    domainFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
    images: z.ZodOptional<z.ZodArray<z.ZodString>>;
    viewport: z.ZodOptional<z.ZodEnum<{
        desktop: "desktop";
        mobile: "mobile";
    }>>;
    description: z.ZodOptional<z.ZodString>;
    clientId: z.ZodString;
}, z.core.$strip>;
export type ExecutableTaskDescriptor = z.infer<typeof ExecutableTaskDescriptorSchema>;
export declare const RouterConfigSchema: z.ZodObject<{
    perplexityApiKey: z.ZodString;
    openrouterApiKey: z.ZodString;
    openrouterBaseUrl: z.ZodOptional<z.ZodString>;
    appName: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodObject<{
        monthlyBudgetPerClient: z.ZodOptional<z.ZodNumber>;
        weeklyTarget: z.ZodOptional<z.ZodNumber>;
        weeklyHardCeiling: z.ZodOptional<z.ZodNumber>;
        globalMonthlyHardCeiling: z.ZodOptional<z.ZodNumber>;
        surgeThreshold: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    circuitBreaker: z.ZodOptional<z.ZodObject<{
        failureThreshold: z.ZodOptional<z.ZodNumber>;
        openDurationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    providerTimeoutMs: z.ZodOptional<z.ZodNumber>;
    providerMaxRetries: z.ZodOptional<z.ZodNumber & z.ZodType<0, number, z.core.$ZodTypeInternals<0, number>>>;
}, z.core.$strip>;
interface PublicIssue {
    path: Array<string | number>;
    message: string;
    code: string;
}
export declare class TaskValidationError extends Error {
    readonly issues: PublicIssue[];
    constructor(message: string, issues: PublicIssue[]);
    toJSON(): Record<string, unknown>;
}
export declare class RouterConfigValidationError extends Error {
    readonly issues: PublicIssue[];
    constructor(message: string, issues: PublicIssue[]);
    toJSON(): Record<string, unknown>;
}
export declare function parseTaskDescriptor(task: unknown): TaskDescriptor;
export declare function parseExecutableTaskDescriptor(task: unknown): ExecutableTaskDescriptor;
export declare function parseRouterConfig(config: unknown): RouterConfig;
export {};
//# sourceMappingURL=schemas.d.ts.map