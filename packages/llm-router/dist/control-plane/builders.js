import { canonicalize, CanonicalJsonError, canonicalJson, compareCodeUnits, sha256Hex } from './canonical-json.js';
import { LLM_EXECUTION_RECORD_SCHEMA_VERSION, LLM_FEEDBACK_SIGNAL_SCHEMA_VERSION, LLM_ROUTE_PLAN_SCHEMA_VERSION, TASK_PROFILE_SCHEMA_VERSION, LLMExecutionRecordSchema, LLMFeedbackSignalSchema, LLMRoutePlanSchema, TaskProfileSchema, } from './contracts.js';
function formatControlPlaneIssues(issues) {
    return issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`).join('; ');
}
export class ControlPlaneValidationError extends Error {
    artifact;
    issues;
    constructor(artifact, issues) {
        super(`Invalid ${artifact}: ${formatControlPlaneIssues(issues)}`);
        this.artifact = artifact;
        this.issues = issues;
        this.name = 'ControlPlaneValidationError';
    }
    toJSON() { return { name: this.name, message: this.message, artifact: this.artifact, issues: this.issues }; }
}
function issuesOf(error) {
    return error.issues.map(issue => ({ path: issue.path.map(String).join('.'), message: issue.message, code: issue.code }));
}
function parse(schema, value, artifact) {
    const result = schema.safeParse(value);
    if (!result.success)
        throw new ControlPlaneValidationError(artifact, issuesOf(result.error));
    return result.data;
}
function normalizeInput(value, artifact) {
    try {
        return canonicalize(value);
    }
    catch (error) {
        if (error instanceof CanonicalJsonError) {
            throw new ControlPlaneValidationError(artifact, [{ path: '(root)', message: error.message, code: 'canonical_json' }]);
        }
        throw error;
    }
}
function normalizeString(value) { return value.normalize('NFC'); }
function sortedUniqueStrings(values) { return [...new Set(values.map(normalizeString))].sort(compareCodeUnits); }
function sortedUniqueTargets(values) {
    const normalized = values.map(value => ({ ...value, provider: normalizeString(value.provider), model: normalizeString(value.model) }));
    return [...new Map(normalized.map(value => [`${value.provider}\u0000${value.model}`, value])).values()].sort((left, right) => left.provider === right.provider ? compareCodeUnits(left.model, right.model) : compareCodeUnits(left.provider, right.provider));
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const entry of Object.values(value))
            deepFreeze(entry);
    }
    return value;
}
export function buildTaskProfile(input) {
    const normalized = normalizeInput(input, 'TaskProfile');
    const withoutHash = { schema_version: TASK_PROFILE_SCHEMA_VERSION, ...normalized };
    return deepFreeze(parse(TaskProfileSchema, { ...withoutHash, task_profile_hash: sha256Hex(withoutHash) }, 'TaskProfile'));
}
export function verifyTaskProfile(profile) {
    const parsed = parse(TaskProfileSchema, profile, 'TaskProfile');
    const { task_profile_hash, ...withoutHash } = parsed;
    if (sha256Hex(withoutHash) !== task_profile_hash)
        throw new ControlPlaneValidationError('TaskProfile', [{ path: 'task_profile_hash', message: 'hash mismatch', code: 'custom' }]);
    return deepFreeze(parsed);
}
function routeFingerprintPayload(input) {
    return {
        task_profile_hash: input.task_profile_hash,
        selected: input.selected,
        search: input.search,
        fallback_chain: input.fallback_chain,
        policy_decision: input.policy_decision,
        budget_decision: { status: input.budget_decision.status },
        provider_health_decision: { status: input.provider_health_decision.status },
        learned_candidate_refs: input.learned_candidate_refs,
        dispatch_allowed: input.dispatch_allowed,
    };
}
export function buildRoutePlan(input) {
    const normalized = normalizeInput({
        ...input,
        fallback_chain: sortedUniqueTargets(input.fallback_chain),
        policy_decision: { ...input.policy_decision, applied_rules: sortedUniqueStrings(input.policy_decision.applied_rules), blockers: sortedUniqueStrings(input.policy_decision.blockers) },
        learned_candidate_refs: sortedUniqueStrings(input.learned_candidate_refs),
    }, 'LLMRoutePlan');
    const route_fingerprint = `route_${sha256Hex(routeFingerprintPayload(normalized)).slice(0, 32)}`;
    const plan_id = `plan_${sha256Hex({ request_id: normalized.request_id, route_fingerprint }).slice(0, 32)}`;
    const withoutHash = { schema_version: LLM_ROUTE_PLAN_SCHEMA_VERSION, route_fingerprint, plan_id, ...normalized };
    return deepFreeze(parse(LLMRoutePlanSchema, { ...withoutHash, content_hash: sha256Hex(withoutHash) }, 'LLMRoutePlan'));
}
export function verifyRoutePlan(plan) {
    const parsed = parse(LLMRoutePlanSchema, plan, 'LLMRoutePlan');
    const { content_hash, route_fingerprint, plan_id } = parsed;
    const input = {
        request_id: parsed.request_id,
        task_profile_hash: parsed.task_profile_hash,
        selected: parsed.selected,
        search: parsed.search,
        fallback_chain: parsed.fallback_chain,
        policy_decision: parsed.policy_decision,
        budget_decision: parsed.budget_decision,
        provider_health_decision: parsed.provider_health_decision,
        learned_candidate_refs: parsed.learned_candidate_refs,
        route_reason: parsed.route_reason,
        dispatch_allowed: parsed.dispatch_allowed,
    };
    const expectedFingerprint = `route_${sha256Hex(routeFingerprintPayload(input)).slice(0, 32)}`;
    const expectedPlanId = `plan_${sha256Hex({ request_id: parsed.request_id, route_fingerprint: expectedFingerprint }).slice(0, 32)}`;
    const withoutHash = {
        schema_version: parsed.schema_version,
        route_fingerprint: parsed.route_fingerprint,
        plan_id: parsed.plan_id,
        ...input,
    };
    const issues = [];
    if (route_fingerprint !== expectedFingerprint)
        issues.push({ path: 'route_fingerprint', message: 'fingerprint mismatch', code: 'custom' });
    if (plan_id !== expectedPlanId)
        issues.push({ path: 'plan_id', message: 'plan identity mismatch', code: 'custom' });
    if (content_hash !== sha256Hex(withoutHash))
        issues.push({ path: 'content_hash', message: 'hash mismatch', code: 'custom' });
    if (issues.length > 0)
        throw new ControlPlaneValidationError('LLMRoutePlan', issues);
    return deepFreeze(parsed);
}
export function buildExecutionRecord(input) {
    const normalized = normalizeInput(input, 'LLMExecutionRecord');
    const withoutHash = { schema_version: LLM_EXECUTION_RECORD_SCHEMA_VERSION, ...normalized };
    return deepFreeze(parse(LLMExecutionRecordSchema, { ...withoutHash, content_hash: sha256Hex(withoutHash) }, 'LLMExecutionRecord'));
}
export function verifyExecutionRecord(record) {
    const parsed = parse(LLMExecutionRecordSchema, record, 'LLMExecutionRecord');
    const { content_hash, ...withoutHash } = parsed;
    if (content_hash !== sha256Hex(withoutHash))
        throw new ControlPlaneValidationError('LLMExecutionRecord', [{ path: 'content_hash', message: 'hash mismatch', code: 'custom' }]);
    return deepFreeze(parsed);
}
export function buildFeedbackSignal(input) {
    const normalized = normalizeInput({ ...input, evidence_refs: sortedUniqueStrings(input.evidence_refs) }, 'LLMFeedbackSignal');
    const withoutHash = { schema_version: LLM_FEEDBACK_SIGNAL_SCHEMA_VERSION, signal_family: 'llm_routing', ...normalized };
    return deepFreeze(parse(LLMFeedbackSignalSchema, { ...withoutHash, content_hash: sha256Hex(withoutHash) }, 'LLMFeedbackSignal'));
}
export function verifyFeedbackSignal(signal) {
    const parsed = parse(LLMFeedbackSignalSchema, signal, 'LLMFeedbackSignal');
    const { content_hash, ...withoutHash } = parsed;
    if (content_hash !== sha256Hex(withoutHash))
        throw new ControlPlaneValidationError('LLMFeedbackSignal', [{ path: 'content_hash', message: 'hash mismatch', code: 'custom' }]);
    return deepFreeze(parsed);
}
export function canonicalBytes(value) { return new TextEncoder().encode(canonicalJson(value)); }
//# sourceMappingURL=builders.js.map