import { type LLMExecutionRecord, type LLMExecutionRecordInput, type LLMFeedbackSignal, type LLMFeedbackSignalInput, type LLMRoutePlan, type LLMRoutePlanInput, type TaskProfile, type TaskProfileInput } from './contracts.js';
export declare class ControlPlaneValidationError extends Error {
    readonly artifact: string;
    readonly issues: Array<{
        path: string;
        message: string;
        code: string;
    }>;
    constructor(artifact: string, issues: Array<{
        path: string;
        message: string;
        code: string;
    }>);
    toJSON(): Record<string, unknown>;
}
export declare function buildTaskProfile(input: TaskProfileInput): TaskProfile;
export declare function verifyTaskProfile(profile: unknown): TaskProfile;
export declare function buildRoutePlan(input: LLMRoutePlanInput): LLMRoutePlan;
export declare function verifyRoutePlan(plan: unknown): LLMRoutePlan;
export declare function buildExecutionRecord(input: LLMExecutionRecordInput): LLMExecutionRecord;
export declare function verifyExecutionRecord(record: unknown): LLMExecutionRecord;
export declare function buildFeedbackSignal(input: LLMFeedbackSignalInput): LLMFeedbackSignal;
export declare function verifyFeedbackSignal(signal: unknown): LLMFeedbackSignal;
export declare function canonicalBytes(value: unknown): Uint8Array;
//# sourceMappingURL=builders.d.ts.map