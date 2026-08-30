import type { PolicyDecision, TaskProfile } from './contracts.js';
export interface BudgetSnapshot {
    snapshot_id: string;
    tenant_id: string;
    period: 'daily' | 'weekly' | 'monthly';
    remaining: number;
    ceiling: number;
    reserved: number;
}
export interface CapabilitySnapshot {
    snapshot_id: string;
    provider: string;
    models: readonly string[];
}
/** Policy evaluation must be pure over explicit immutable snapshots. */
export interface PolicyEngine {
    evaluate(profile: TaskProfile, budget: Readonly<BudgetSnapshot>, capabilities: readonly Readonly<CapabilitySnapshot>[]): PolicyDecision;
}
//# sourceMappingURL=policy-engine.d.ts.map