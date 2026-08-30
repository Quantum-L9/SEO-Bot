import { randomUUID } from 'node:crypto';
import { TaskComplexity, } from '../types.js';
export const DEFAULT_BUDGET_CONFIG = Object.freeze({
    monthlyBudgetPerClient: 200,
    weeklyTarget: 50,
    weeklyHardCeiling: 100,
    globalMonthlyHardCeiling: 2_000,
    surgeThreshold: 0.6,
});
export var ThrottleLevel;
(function (ThrottleLevel) {
    ThrottleLevel["NONE"] = "none";
    ThrottleLevel["SOFT"] = "soft";
    ThrottleLevel["HARD"] = "hard";
})(ThrottleLevel || (ThrottleLevel = {}));
export function validateBudgetConfig(config) {
    const positiveFields = [
        'monthlyBudgetPerClient',
        'weeklyTarget',
        'weeklyHardCeiling',
        'globalMonthlyHardCeiling',
    ];
    for (const field of positiveFields) {
        if (!Number.isFinite(config[field]) || config[field] <= 0)
            throw new RangeError(`${field} must be a finite positive number`);
    }
    if (!Number.isFinite(config.surgeThreshold) || config.surgeThreshold < 0 || config.surgeThreshold > 1) {
        throw new RangeError('surgeThreshold must be between 0 and 1');
    }
    if (config.weeklyTarget > config.weeklyHardCeiling) {
        throw new RangeError('weeklyTarget must not exceed weeklyHardCeiling');
    }
}
export function evaluateBudgetAdmission(input) {
    const { state, task, estimatedCost, globalMonthSpend, globalReservedSpend, globalMonthlyHardCeiling } = input;
    const projectedMonth = state.monthSpend + state.reservedSpend + estimatedCost;
    const projectedWeek = state.weekSpend + state.reservedSpend + estimatedCost;
    const projectedGlobal = globalMonthSpend + globalReservedSpend + estimatedCost;
    let level = ThrottleLevel.NONE;
    if (projectedMonth > state.monthlyBudget
        || projectedGlobal > globalMonthlyHardCeiling
        || (projectedWeek > state.weeklyHardCeiling && !state.surgeAllowance)) {
        level = ThrottleLevel.HARD;
    }
    else if (projectedWeek > state.weekTarget || projectedMonth > state.monthlyBudget * 0.8) {
        level = ThrottleLevel.SOFT;
    }
    // Hard ceilings are invariant. Model downgrade cannot make an already-priced
    // reservation safe because the reservation amount was calculated before this
    // decision. Reject and let the caller retry with a newly priced task.
    if (level === ThrottleLevel.HARD) {
        return { level, reason: 'Hard budget ceiling reached; task deferred', allowTask: false, forceDowngrade: false, maxModelTier: 'fast' };
    }
    // Critical tasks may bypass soft throttling, but never a hard ceiling.
    if (task.complexity === TaskComplexity.CRITICAL) {
        return { level: ThrottleLevel.NONE, reason: 'Critical task admitted within hard ceilings', allowTask: true, forceDowngrade: false, maxModelTier: 'critical' };
    }
    if (level === ThrottleLevel.SOFT) {
        return { level, reason: 'Soft throttle; cheaper tier required', allowTask: true, forceDowngrade: true, maxModelTier: task.complexity === TaskComplexity.HIGH ? 'strategic' : 'fast' };
    }
    return { level, reason: 'Within budget', allowTask: true, forceDowngrade: false, maxModelTier: 'critical' };
}
export class BudgetTracker {
    config;
    clients = new Map();
    reservations = new Map();
    globalMonthSpend = 0;
    globalReservedSpend = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
        validateBudgetConfig(this.config);
    }
    initClient(clientId, overrides) {
        if (clientId.trim().length === 0)
            throw new RangeError('clientId must not be empty');
        const clientConfig = { ...this.config, ...overrides };
        validateBudgetConfig(clientConfig);
        const existing = this.clients.get(clientId);
        this.clients.set(clientId, {
            config: clientConfig,
            state: existing?.state ?? {
                clientId,
                monthlyBudget: clientConfig.monthlyBudgetPerClient,
                monthSpend: 0,
                weekSpend: 0,
                weekTarget: clientConfig.weeklyTarget,
                todaySpend: 0,
                weeklyHardCeiling: clientConfig.weeklyHardCeiling,
                surgeAllowance: false,
                remainingMonthly: clientConfig.monthlyBudgetPerClient,
                remainingWeekly: clientConfig.weeklyHardCeiling,
                throttleLevel: 'none',
                reservedSpend: 0,
                activeReservations: 0,
            },
        });
        const record = this.getRecord(clientId);
        record.state.monthlyBudget = clientConfig.monthlyBudgetPerClient;
        record.state.weekTarget = clientConfig.weeklyTarget;
        record.state.weeklyHardCeiling = clientConfig.weeklyHardCeiling;
        this.refreshDerived(record);
    }
    evaluateTask(clientId, task, estimatedCost) {
        const record = this.getRecord(clientId);
        return evaluateBudgetAdmission({
            state: record.state,
            config: record.config,
            task,
            estimatedCost,
            globalMonthSpend: this.globalMonthSpend,
            globalReservedSpend: this.globalReservedSpend,
            globalMonthlyHardCeiling: this.config.globalMonthlyHardCeiling,
        });
    }
    reserveTask(clientId, task, estimatedCost, now = new Date(), idFactory = randomUUID) {
        if (!Number.isFinite(estimatedCost) || estimatedCost < 0)
            throw new RangeError('estimatedCost must be a finite non-negative number');
        const decision = this.evaluateTask(clientId, task, estimatedCost);
        if (!decision.allowTask)
            throw new BudgetReservationError(decision.reason);
        const record = this.getRecord(clientId);
        const reservation = { id: idFactory(), clientId, estimatedCost, createdAt: now.toISOString() };
        if (reservation.id.length === 0)
            throw new BudgetReservationError('Budget reservation ID must not be empty');
        if (this.reservations.has(reservation.id))
            throw new BudgetReservationError(`Duplicate budget reservation ID: ${reservation.id}`);
        this.reservations.set(reservation.id, reservation);
        record.state.reservedSpend += estimatedCost;
        record.state.activeReservations += 1;
        this.globalReservedSpend += estimatedCost;
        this.refreshDerived(record);
        return { decision, reservation };
    }
    reconcile(reservationId, actualCost) {
        if (!Number.isFinite(actualCost) || actualCost < 0)
            throw new RangeError('actualCost must be a finite non-negative number');
        const reservation = this.takeReservation(reservationId);
        const record = this.getRecord(reservation.clientId);
        this.releaseReservationAmounts(record, reservation);
        this.commitSpend(record, actualCost);
    }
    release(reservationId) {
        const reservation = this.takeReservation(reservationId);
        const record = this.getRecord(reservation.clientId);
        this.releaseReservationAmounts(record, reservation);
        this.refreshDerived(record);
    }
    recordSpend(clientId, amount) {
        if (!Number.isFinite(amount) || amount < 0)
            throw new RangeError('amount must be a finite non-negative number');
        this.commitSpend(this.getRecord(clientId), amount);
    }
    resetDaily(clientId) { this.getRecord(clientId).state.todaySpend = 0; }
    resetWeekly(clientId) {
        const record = this.getRecord(clientId);
        record.state.weekSpend = 0;
        record.state.surgeAllowance = false;
        this.refreshDerived(record);
    }
    resetMonthly(clientId) {
        const record = this.getRecord(clientId);
        record.state.monthSpend = 0;
        record.state.weekSpend = 0;
        record.state.todaySpend = 0;
        record.state.surgeAllowance = false;
        this.refreshDerived(record);
    }
    resetGlobalMonthly() { this.globalMonthSpend = 0; }
    checkSurgeAllowance(clientId, dayOfWeek) {
        const record = this.getRecord(clientId);
        if (dayOfWeek >= 4 && record.state.weekSpend / record.state.weekTarget < record.config.surgeThreshold)
            record.state.surgeAllowance = true;
        return record.state.surgeAllowance;
    }
    getClientBudgetReport(clientId) { return { ...this.getRecord(clientId).state }; }
    getAllBudgetReports() { return Array.from(this.clients.values(), entry => ({ ...entry.state })); }
    getGlobalSpend() {
        return {
            monthSpend: this.globalMonthSpend,
            reservedSpend: this.globalReservedSpend,
            ceiling: this.config.globalMonthlyHardCeiling,
            utilization: (this.globalMonthSpend + this.globalReservedSpend) / this.config.globalMonthlyHardCeiling,
        };
    }
    getRecord(clientId) {
        const record = this.clients.get(clientId);
        if (!record)
            throw new Error(`Client ${clientId} not initialized. Call initClient() first.`);
        return record;
    }
    takeReservation(id) {
        const reservation = this.reservations.get(id);
        if (!reservation)
            throw new Error(`Unknown or already-settled budget reservation: ${id}`);
        this.reservations.delete(id);
        return reservation;
    }
    releaseReservationAmounts(record, reservation) {
        record.state.reservedSpend = Math.max(0, record.state.reservedSpend - reservation.estimatedCost);
        record.state.activeReservations = Math.max(0, record.state.activeReservations - 1);
        this.globalReservedSpend = Math.max(0, this.globalReservedSpend - reservation.estimatedCost);
    }
    commitSpend(record, amount) {
        record.state.monthSpend += amount;
        record.state.weekSpend += amount;
        record.state.todaySpend += amount;
        this.globalMonthSpend += amount;
        this.refreshDerived(record);
    }
    refreshDerived(record) {
        const state = record.state;
        state.remainingMonthly = state.monthlyBudget - state.monthSpend - state.reservedSpend;
        state.remainingWeekly = state.weeklyHardCeiling - state.weekSpend - state.reservedSpend;
        const decision = evaluateBudgetAdmission({
            state,
            config: record.config,
            task: { type: 'classification', complexity: TaskComplexity.LOW },
            estimatedCost: 0,
            globalMonthSpend: this.globalMonthSpend,
            globalReservedSpend: this.globalReservedSpend,
            globalMonthlyHardCeiling: this.config.globalMonthlyHardCeiling,
        });
        state.throttleLevel = decision.level;
    }
}
export class InMemoryBudgetStore {
    tracker;
    constructor(tracker) {
        this.tracker = tracker;
    }
    async initClient(clientId, overrides) { this.tracker.initClient(clientId, overrides); }
    async reserveTask(clientId, task, estimatedCost, now, idFactory) { return this.tracker.reserveTask(clientId, task, estimatedCost, now, idFactory); }
    async reconcile(reservationId, actualCost) { this.tracker.reconcile(reservationId, actualCost); }
    async release(reservationId) { this.tracker.release(reservationId); }
    async recordSpend(clientId, amount) { this.tracker.recordSpend(clientId, amount); }
    async resetDaily(clientId) { this.tracker.resetDaily(clientId); }
    async resetWeekly(clientId) { this.tracker.resetWeekly(clientId); }
    async resetMonthly(clientId) { this.tracker.resetMonthly(clientId); }
    async resetGlobalMonthly() { this.tracker.resetGlobalMonthly(); }
    async checkSurgeAllowance(clientId, dayOfWeek) { return this.tracker.checkSurgeAllowance(clientId, dayOfWeek); }
    async getClientBudgetReport(clientId) { return this.tracker.getClientBudgetReport(clientId); }
    async getAllBudgetReports() { return this.tracker.getAllBudgetReports(); }
    async getGlobalSpend() { return this.tracker.getGlobalSpend(); }
}
export class BudgetReservationError extends Error {
    constructor(message) { super(message); this.name = 'BudgetReservationError'; }
}
//# sourceMappingURL=index.js.map