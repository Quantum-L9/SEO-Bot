import { z } from 'zod';
import { compareCodeUnits } from './canonical-json.js';
const trimmed = (label, max = 512) => z.string().min(1, `${label} is required`).max(max).refine(value => value === value.trim(), `${label} must not contain surrounding whitespace`);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase SHA-256 hex');
const routeIdentity = z.string().regex(/^route_[0-9a-f]{32}$/);
const planIdentity = z.string().regex(/^plan_[0-9a-f]{32}$/);
const sortedUnique = (item) => z.array(item).superRefine((values, context) => {
    const serialized = values.map(value => typeof value === 'string' ? value : JSON.stringify(value));
    const expected = [...new Set(serialized)].sort(compareCodeUnits);
    if (serialized.length !== expected.length || serialized.some((value, index) => value !== expected[index]))
        context.addIssue({ code: 'custom', message: 'array must be sorted and unique' });
});
export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'mistral', 'gemini', 'deepseek', 'perplexity', 'openrouter']);
export const TaskFamilySchema = z.enum(['classification', 'extraction', 'scoring', 'proposal_generation', 'friction_analysis', 'architecture_review', 'contract_generation', 'contract_hardening', 'evidence_synthesis', 'signal_generation', 'adr_generation', 'risk_assessment', 'validation_interpretation', 'memory_episode_summarization', 'graph_fact_extraction', 'promotion_recommendation', 'fact_verification', 'deep_research', 'code_generation', 'vision_analysis']);
export const TaskComplexityLevelSchema = z.enum(['trivial', 'low', 'medium', 'high', 'critical']);
export const DataSensitivitySchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export const FreshnessRequirementSchema = z.enum(['none', 'hour', 'day', 'week', 'month', 'year']);
export const ModalitySchema = z.enum(['text', 'vision', 'multimodal']);
export const LatencyClassSchema = z.enum(['realtime', 'fast', 'normal', 'slow']);
export const ValidationProfileSchema = z.enum(['strict_json', 'cited_answer', 'freeform', 'code', 'visual']);
export const ReasoningDepthSchema = z.enum(['none', 'low', 'medium', 'high']);
export const ResponseFormatSchema = z.enum(['text', 'json']);
export const SearchModeSchema = z.enum(['web', 'academic', 'sec']);
export const SearchContextSizeSchema = z.enum(['low', 'medium', 'high']);
export const RecencyFilterSchema = z.enum(['hour', 'day', 'week', 'month', 'year', 'none']);
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export const TASK_PROFILE_SCHEMA_VERSION = 'l9-llm-task-profile/v1';
export const TaskProfileSchema = z.object({
    schema_version: z.literal(TASK_PROFILE_SCHEMA_VERSION),
    action: trimmed('action'),
    node_id: trimmed('node_id', 128),
    tenant_id: trimmed('tenant_id', 128),
    task_family: TaskFamilySchema,
    complexity: TaskComplexityLevelSchema,
    data_sensitivity: DataSensitivitySchema,
    requires_search: z.boolean(),
    requires_citations: z.boolean(),
    requires_json: z.boolean(),
    required_output_schema: trimmed('required_output_schema', 2048).nullable(),
    freshness_requirement: FreshnessRequirementSchema,
    modality: ModalitySchema,
    expected_output_tokens: z.number().int().positive().nullable(),
    max_latency_class: LatencyClassSchema,
    evidence_required: z.boolean(),
    prompt_contract_ref: trimmed('prompt_contract_ref', 512).nullable(),
    validation_profile: ValidationProfileSchema,
    task_profile_hash: sha256,
}).strict().superRefine((profile, context) => {
    if (profile.requires_json && !profile.required_output_schema)
        context.addIssue({ code: 'custom', path: ['required_output_schema'], message: 'JSON tasks require an output schema reference' });
    if (profile.requires_citations && !profile.requires_search && !profile.evidence_required)
        context.addIssue({ code: 'custom', path: ['requires_citations'], message: 'citations require search or explicit evidence' });
    if (profile.modality === 'vision' && profile.validation_profile !== 'visual')
        context.addIssue({ code: 'custom', path: ['validation_profile'], message: 'vision tasks require the visual validation profile' });
});
export const SelectedRouteSchema = z.object({
    provider: ProviderIdSchema,
    model: trimmed('model', 256),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive(),
    reasoning_depth: ReasoningDepthSchema,
    response_format: ResponseFormatSchema,
}).strict();
export const SearchDecisionSchema = z.object({
    enabled: z.boolean(),
    provider: z.literal('perplexity').nullable(),
    search_mode: SearchModeSchema.nullable(),
    search_context_size: SearchContextSizeSchema.nullable(),
    recency_filter: RecencyFilterSchema.nullable(),
    variations: z.number().int().positive().nullable(),
    reasoning_effort: ReasoningEffortSchema.nullable(),
}).strict().superRefine((search, context) => {
    const dependent = ['provider', 'search_mode', 'search_context_size', 'recency_filter', 'variations'];
    if (search.enabled) {
        for (const key of dependent)
            if (search[key] === null)
                context.addIssue({ code: 'custom', path: [key], message: `${key} is required when search is enabled` });
    }
    else if ([search.provider, search.search_mode, search.search_context_size, search.recency_filter, search.variations, search.reasoning_effort].some(value => value !== null)) {
        context.addIssue({ code: 'custom', message: 'disabled search must not carry search configuration' });
    }
});
export const RouteTargetSchema = z.object({ provider: ProviderIdSchema, model: trimmed('fallback model', 256) }).strict();
export const PolicyDecisionSchema = z.object({ status: z.enum(['allowed', 'modified', 'blocked']), applied_rules: sortedUnique(trimmed('rule', 256)), blockers: sortedUnique(trimmed('blocker', 512)) }).strict().superRefine((decision, context) => {
    if (decision.status === 'blocked' && decision.blockers.length === 0)
        context.addIssue({ code: 'custom', path: ['blockers'], message: 'blocked policy decisions require at least one blocker' });
    if (decision.status !== 'blocked' && decision.blockers.length > 0)
        context.addIssue({ code: 'custom', path: ['blockers'], message: 'non-blocked decisions cannot carry blockers' });
});
export const BudgetDecisionSchema = z.object({ status: z.enum(['allowed', 'downgraded', 'blocked']), reason: trimmed('budget reason', 1024) }).strict();
export const ProviderHealthDecisionSchema = z.object({ status: z.enum(['healthy', 'degraded', 'unavailable', 'unknown']), reason: trimmed('health reason', 1024) }).strict();
export const LLM_ROUTE_PLAN_SCHEMA_VERSION = 'l9-llm-route-plan/v1';
export const LLMRoutePlanSchema = z.object({
    schema_version: z.literal(LLM_ROUTE_PLAN_SCHEMA_VERSION),
    route_fingerprint: routeIdentity,
    plan_id: planIdentity,
    request_id: trimmed('request_id', 256),
    task_profile_hash: sha256,
    selected: SelectedRouteSchema,
    search: SearchDecisionSchema,
    fallback_chain: sortedUnique(RouteTargetSchema),
    policy_decision: PolicyDecisionSchema,
    budget_decision: BudgetDecisionSchema,
    provider_health_decision: ProviderHealthDecisionSchema,
    learned_candidate_refs: sortedUnique(trimmed('candidate reference', 512)),
    route_reason: trimmed('route_reason', 2048),
    dispatch_allowed: z.boolean(),
    content_hash: sha256,
}).strict().superRefine((plan, context) => {
    const blocked = plan.policy_decision.status === 'blocked' || plan.budget_decision.status === 'blocked' || ['unavailable', 'unknown'].includes(plan.provider_health_decision.status);
    if (plan.dispatch_allowed === blocked)
        context.addIssue({ code: 'custom', path: ['dispatch_allowed'], message: 'dispatch_allowed contradicts policy, budget, or health decisions' });
    if (plan.search.enabled && plan.selected.provider !== 'perplexity' && plan.search.provider !== 'perplexity')
        context.addIssue({ code: 'custom', path: ['search'], message: 'enabled search requires a Perplexity search decision' });
    if (plan.fallback_chain.some(target => target.provider === plan.selected.provider && target.model === plan.selected.model))
        context.addIssue({ code: 'custom', path: ['fallback_chain'], message: 'fallback chain cannot repeat the selected route' });
});
export const LLM_EXECUTION_RECORD_SCHEMA_VERSION = 'l9-llm-execution-record/v1';
const LLMExecutionRecordObject = z.object({
    schema_version: z.literal(LLM_EXECUTION_RECORD_SCHEMA_VERSION),
    request_id: trimmed('request_id', 256),
    plan_id: planIdentity,
    route_fingerprint: routeIdentity,
    tenant_id: trimmed('tenant_id', 128),
    node_id: trimmed('node_id', 128),
    action: trimmed('action'),
    task_profile_hash: sha256,
    provider: ProviderIdSchema,
    model: trimmed('model', 256),
    config_hash: sha256,
    prompt_hash: sha256,
    input_hash: sha256,
    output_hash: sha256,
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().finite(),
    latency_ms: z.number().nonnegative().finite(),
    citations_count: z.number().int().nonnegative(),
    fallback_used: z.boolean(),
    fallback_from: RouteTargetSchema.nullable(),
    validation_status: z.enum(['passed', 'failed', 'not_run', 'blocked']),
    schema_valid: z.boolean().nullable(),
    downstream_accepted: z.boolean().nullable(),
    quality_score: z.number().min(0).max(1).nullable(),
    failure_reason: trimmed('failure_reason', 2048).nullable(),
    provider_request_id: trimmed('provider_request_id', 256).nullable(),
    pricing_version: trimmed('pricing_version', 256),
    finish_reason: trimmed('finish_reason', 256).nullable(),
    generated_at: z.string().datetime({ offset: true }),
    content_hash: sha256,
}).strict();
function tokenAndFallbackIssues(record) {
    const issues = [];
    if (record.total_tokens !== record.input_tokens + record.output_tokens)
        issues.push({ path: ['total_tokens'], message: 'total_tokens must equal input_tokens + output_tokens' });
    if (record.fallback_used !== (record.fallback_from !== null))
        issues.push({ path: ['fallback_from'], message: 'fallback metadata is inconsistent' });
    if (record.fallback_from && record.fallback_from.provider === record.provider && record.fallback_from.model === record.model)
        issues.push({ path: ['fallback_from'], message: 'fallback origin cannot equal the final route' });
    return issues;
}
function validationStatusIssues(record) {
    const issues = [];
    if (record.validation_status === 'failed' && !record.failure_reason)
        issues.push({ path: ['failure_reason'], message: 'failed validation requires a failure reason' });
    if (record.validation_status === 'blocked' && !record.failure_reason)
        issues.push({ path: ['failure_reason'], message: 'blocked validation requires a reason' });
    if (record.validation_status === 'passed' && record.schema_valid !== true)
        issues.push({ path: ['schema_valid'], message: 'passed validation requires schema_valid=true' });
    if (record.validation_status === 'passed' && record.failure_reason !== null)
        issues.push({ path: ['failure_reason'], message: 'passed validation cannot carry a failure reason' });
    if (record.validation_status === 'not_run' && (record.schema_valid !== null || record.downstream_accepted !== null || record.failure_reason !== null))
        issues.push({ path: ['validation_status'], message: 'not_run validation cannot carry validation outcomes' });
    if (record.downstream_accepted === true && record.validation_status !== 'passed')
        issues.push({ path: ['downstream_accepted'], message: 'accepted output requires passed validation' });
    return issues;
}
export const LLMExecutionRecordSchema = LLMExecutionRecordObject.superRefine((record, context) => {
    for (const issue of [...tokenAndFallbackIssues(record), ...validationStatusIssues(record)]) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
});
export const LLM_FEEDBACK_SIGNAL_SCHEMA_VERSION = 'l9-llm-router-signal/v1';
export const LLMFeedbackSignalSchema = z.object({
    schema_version: z.literal(LLM_FEEDBACK_SIGNAL_SCHEMA_VERSION),
    signal_family: z.literal('llm_routing'),
    signal_type: z.enum(['route_success', 'route_failure', 'fallback_used', 'provider_degraded', 'high_cost', 'low_cost_high_quality', 'citation_missing', 'citation_strong', 'json_parse_failed', 'schema_validation_failed', 'hallucination_suspected', 'output_rejected', 'output_accepted', 'latency_high', 'retry_required', 'best_config_candidate']),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    task_profile_hash: sha256,
    route_fingerprint: routeIdentity,
    plan_id: planIdentity,
    evidence_refs: sortedUnique(trimmed('evidence reference', 512)),
    content_hash: sha256,
}).strict();
//# sourceMappingURL=contracts.js.map