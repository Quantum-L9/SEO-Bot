import { z } from 'zod';
import { RecencyFilter, TaskComplexity, TaskType, } from './types.js';
export const TaskDescriptorSchema = z.object({
    type: z.nativeEnum(TaskType),
    complexity: z.nativeEnum(TaskComplexity),
    expectedOutputTokens: z.number().int().positive().optional(),
    requiresReasoning: z.boolean().optional(),
    requiresSearch: z.boolean().optional(),
    recency: z.nativeEnum(RecencyFilter).optional(),
    domainFilter: z.array(z.string().min(1)).optional(),
    images: z.array(z.string().min(1)).optional(),
    viewport: z.enum(['desktop', 'mobile']).optional(),
    clientId: z.string().min(1).optional(),
    description: z.string().optional(),
});
export const ExecutableTaskDescriptorSchema = TaskDescriptorSchema.extend({
    clientId: z.string().min(1, 'clientId is required for budget tracking'),
});
const BudgetConfigPartialSchema = z.object({
    monthlyBudgetPerClient: z.number().positive(),
    weeklyTarget: z.number().positive(),
    weeklyHardCeiling: z.number().positive(),
    globalMonthlyHardCeiling: z.number().positive(),
    surgeThreshold: z.number().min(0).max(1),
}).partial();
const CircuitBreakerConfigPartialSchema = z.object({
    failureThreshold: z.number().int().positive(),
    openDurationMs: z.number().int().positive(),
}).partial();
export const RouterConfigSchema = z.object({
    perplexityApiKey: z.string().min(1, 'perplexityApiKey is required'),
    openrouterApiKey: z.string().min(1, 'openrouterApiKey is required'),
    openrouterBaseUrl: z.string().url('openrouterBaseUrl must be an absolute URL').refine((value) => {
        try {
            const protocol = new URL(value).protocol;
            return protocol === 'https:' || protocol === 'http:';
        }
        catch {
            return false;
        }
    }, { message: 'openrouterBaseUrl must use http(s)' }).optional(),
    appName: z.string().min(1).optional(),
    budget: BudgetConfigPartialSchema.optional(),
    circuitBreaker: CircuitBreakerConfigPartialSchema.optional(),
    providerTimeoutMs: z.number().int().positive().optional(),
    providerMaxRetries: z.number().int().refine(value => value === 0, {
        message: 'providerMaxRetries must remain 0 so attempts stay explicit',
    }).optional(),
});
function publicIssues(error) {
    return error.issues.map(issue => ({
        path: issue.path.map(segment => typeof segment === 'symbol' ? String(segment) : segment),
        message: issue.message,
        code: issue.code,
    }));
}
function formatIssues(issues) {
    return issues.map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
}
export class TaskValidationError extends Error {
    issues;
    constructor(message, issues) {
        super(message);
        this.issues = issues;
        this.name = 'TaskValidationError';
    }
    toJSON() { return { name: this.name, message: this.message, issues: this.issues }; }
}
export class RouterConfigValidationError extends Error {
    issues;
    constructor(message, issues) {
        super(message);
        this.issues = issues;
        this.name = 'RouterConfigValidationError';
    }
    toJSON() { return { name: this.name, message: this.message, issues: this.issues }; }
}
function parseTaskWithSchema(schema, task) {
    const result = schema.safeParse(task);
    if (!result.success) {
        const issues = publicIssues(result.error);
        throw new TaskValidationError(`Invalid TaskDescriptor: ${formatIssues(issues)}`, issues);
    }
    return result.data;
}
export function parseTaskDescriptor(task) {
    return parseTaskWithSchema(TaskDescriptorSchema, task);
}
export function parseExecutableTaskDescriptor(task) {
    return parseTaskWithSchema(ExecutableTaskDescriptorSchema, task);
}
export function parseRouterConfig(config) {
    const result = RouterConfigSchema.safeParse(config);
    if (!result.success) {
        const issues = publicIssues(result.error);
        throw new RouterConfigValidationError(`Invalid RouterConfig: ${formatIssues(issues)}`, issues);
    }
    return result.data;
}
//# sourceMappingURL=schemas.js.map