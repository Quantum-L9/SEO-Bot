import { type BudgetConfig, type BudgetReservation, type BudgetState, type TaskDescriptor } from '../types.js';
export declare const DEFAULT_BUDGET_CONFIG: BudgetConfig;
export declare enum ThrottleLevel {
    NONE = "none",
    SOFT = "soft",
    HARD = "hard"
}
export interface ThrottleDecision {
    level: ThrottleLevel;
    reason: string;
    allowTask: boolean;
    forceDowngrade: boolean;
    maxModelTier: 'fast' | 'strategic' | 'critical';
}
export interface GlobalBudgetState {
    monthSpend: number;
    reservedSpend: number;
    ceiling: number;
    utilization: number;
}
export interface BudgetAdmissionInput {
    state: BudgetState;
    config: BudgetConfig;
    task: TaskDescriptor;
    estimatedCost: number;
    globalMonthSpend: number;
    globalReservedSpend: number;
    globalMonthlyHardCeiling: number;
}
export interface BudgetStore {
    initClient(clientId: string, overrides?: Partial<BudgetConfig>): Promise<void>;
    reserveTask(clientId: string, task: TaskDescriptor, estimatedCost: number, now?: Date, idFactory?: () => string): Promise<{
        decision: ThrottleDecision;
        reservation: BudgetReservation;
    }>;
    reconcile(reservationId: string, actualCost: number): Promise<void>;
    release(reservationId: string): Promise<void>;
    recordSpend(clientId: string, amount: number): Promise<void>;
    resetDaily(clientId: string): Promise<void>;
    resetWeekly(clientId: string): Promise<void>;
    resetMonthly(clientId: string): Promise<void>;
    resetGlobalMonthly(): Promise<void>;
    checkSurgeAllowance(clientId: string, dayOfWeek: number): Promise<boolean>;
    getClientBudgetReport(clientId: string): Promise<BudgetState>;
    getAllBudgetReports(): Promise<BudgetState[]>;
    getGlobalSpend(): Promise<GlobalBudgetState>;
}
export declare function validateBudgetConfig(config: BudgetConfig): void;
export declare function evaluateBudgetAdmission(input: BudgetAdmissionInput): ThrottleDecision;
export declare class BudgetTracker {
    private readonly config;
    private readonly clients;
    private readonly reservations;
    private globalMonthSpend;
    private globalReservedSpend;
    constructor(config?: Partial<BudgetConfig>);
    initClient(clientId: string, overrides?: Partial<BudgetConfig>): void;
    evaluateTask(clientId: string, task: TaskDescriptor, estimatedCost: number): ThrottleDecision;
    reserveTask(clientId: string, task: TaskDescriptor, estimatedCost: number, now?: Date, idFactory?: () => string): {
        decision: ThrottleDecision;
        reservation: BudgetReservation;
    };
    reconcile(reservationId: string, actualCost: number): void;
    release(reservationId: string): void;
    recordSpend(clientId: string, amount: number): void;
    resetDaily(clientId: string): void;
    resetWeekly(clientId: string): void;
    resetMonthly(clientId: string): void;
    resetGlobalMonthly(): void;
    checkSurgeAllowance(clientId: string, dayOfWeek: number): boolean;
    getClientBudgetReport(clientId: string): BudgetState;
    getAllBudgetReports(): BudgetState[];
    getGlobalSpend(): GlobalBudgetState;
    private getRecord;
    private takeReservation;
    private releaseReservationAmounts;
    private commitSpend;
    private refreshDerived;
}
export declare class InMemoryBudgetStore implements BudgetStore {
    readonly tracker: BudgetTracker;
    constructor(tracker: BudgetTracker);
    initClient(clientId: string, overrides?: Partial<BudgetConfig>): Promise<void>;
    reserveTask(clientId: string, task: TaskDescriptor, estimatedCost: number, now?: Date, idFactory?: () => string): Promise<{
        decision: ThrottleDecision;
        reservation: BudgetReservation;
    }>;
    reconcile(reservationId: string, actualCost: number): Promise<void>;
    release(reservationId: string): Promise<void>;
    recordSpend(clientId: string, amount: number): Promise<void>;
    resetDaily(clientId: string): Promise<void>;
    resetWeekly(clientId: string): Promise<void>;
    resetMonthly(clientId: string): Promise<void>;
    resetGlobalMonthly(): Promise<void>;
    checkSurgeAllowance(clientId: string, dayOfWeek: number): Promise<boolean>;
    getClientBudgetReport(clientId: string): Promise<BudgetState>;
    getAllBudgetReports(): Promise<BudgetState[]>;
    getGlobalSpend(): Promise<GlobalBudgetState>;
}
export declare class BudgetReservationError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=index.d.ts.map