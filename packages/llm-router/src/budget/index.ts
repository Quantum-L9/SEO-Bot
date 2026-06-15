/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/budget/index.ts
 * @purpose Budget enforcement engine with trajectory-based throttling and surge awareness
 * @design No daily hard cap. Monthly budget per client. Weekly trajectory. Surge-aware.
 * @principle Never kill an autonomous reasoning task due to being cheap on token spend.
 */

import { BudgetState, BudgetConfig, TaskDescriptor, TaskComplexity } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// DEFAULT BUDGET CONFIG
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  monthlyBudgetPerClient: 200.0,    // $200/month per domain
  weeklyTarget: 50.0,               // $50/week soft target (Mon-Fri)
  weeklyHardCeiling: 100.0,         // $100/week hard ceiling (safety net = 2x target)
  globalMonthlyHardCeiling: 2000.0, // $2000/month across all clients
  surgeThreshold: 0.6,              // If week spend < 60% of target by Thursday, allow surge
};

// ═══════════════════════════════════════════════════════════════
// THROTTLE LEVELS
// ═══════════════════════════════════════════════════════════════

export enum ThrottleLevel {
  NONE = 'none',       // Full speed — no restrictions
  SOFT = 'soft',       // Prefer cheaper models, defer non-critical tasks
  HARD = 'hard',       // Only critical tasks allowed, cheapest models only
}

export interface ThrottleDecision {
  level: ThrottleLevel;
  reason: string;
  allowTask: boolean;
  forceDowngrade: boolean;
  maxModelTier: 'fast' | 'strategic' | 'critical';
}

// ═══════════════════════════════════════════════════════════════
// BUDGET TRACKER
// ═══════════════════════════════════════════════════════════════

export class BudgetTracker {
  private config: BudgetConfig;
  private clientStates: Map<string, BudgetState> = new Map();
  private globalMonthSpend: number = 0;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  // ─────────────────────────────────────────────────────────────
  // STATE MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  /**
   * Initialize or update a client's budget state.
   * Called at bot startup and after each billing period reset.
   */
  initClient(clientId: string, overrides?: Partial<BudgetConfig>): void {
    const clientConfig = overrides
      ? { ...this.config, ...overrides }
      : this.config;

    this.clientStates.set(clientId, {
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
    });
  }

  /**
   * Record a spend event after an LLM call completes.
   */
  recordSpend(clientId: string, amount: number): void {
    const state = this.getState(clientId);
    state.monthSpend += amount;
    state.weekSpend += amount;
    state.todaySpend += amount;
    state.remainingMonthly = state.monthlyBudget - state.monthSpend;
    state.remainingWeekly = state.weeklyHardCeiling - state.weekSpend;
    this.globalMonthSpend += amount;

    // Update throttle level
    state.throttleLevel = this.computeThrottleLevel(state).level;
  }

  /**
   * Reset daily counters (called by scheduler at midnight).
   */
  resetDaily(clientId: string): void {
    const state = this.getState(clientId);
    state.todaySpend = 0;
  }

  /**
   * Reset weekly counters (called by scheduler on Monday).
   */
  resetWeekly(clientId: string): void {
    const state = this.getState(clientId);
    state.weekSpend = 0;
    state.remainingWeekly = state.weeklyHardCeiling;
    state.surgeAllowance = false;
    state.throttleLevel = 'none';
  }

  /**
   * Reset monthly counters (called by scheduler on 1st of month).
   */
  resetMonthly(clientId: string): void {
    const state = this.getState(clientId);
    state.monthSpend = 0;
    state.weekSpend = 0;
    state.todaySpend = 0;
    state.remainingMonthly = state.monthlyBudget;
    state.remainingWeekly = state.weeklyHardCeiling;
    state.surgeAllowance = false;
    state.throttleLevel = 'none';
  }

  resetGlobalMonthly(): void {
    this.globalMonthSpend = 0;
  }

  // ─────────────────────────────────────────────────────────────
  // THROTTLE DECISION ENGINE
  // ─────────────────────────────────────────────────────────────

  /**
   * Determine whether a task should proceed and at what model tier.
   * 
   * Key principle: NEVER kill an autonomous reasoning task due to budget.
   * Instead, downgrade the model tier or defer non-critical work.
   */
  evaluateTask(clientId: string, task: TaskDescriptor, estimatedCost: number): ThrottleDecision {
    const state = this.getState(clientId);
    const throttle = this.computeThrottleLevel(state);

    // CRITICAL tasks ALWAYS proceed — never throttle strategic decisions
    if (task.complexity === TaskComplexity.CRITICAL) {
      return {
        level: ThrottleLevel.NONE,
        reason: 'Critical task — budget override engaged',
        allowTask: true,
        forceDowngrade: false,
        maxModelTier: 'critical',
      };
    }

    // HIGH complexity tasks proceed but may be downgraded under soft throttle
    if (task.complexity === TaskComplexity.HIGH) {
      if (throttle.level === ThrottleLevel.HARD) {
        return {
          level: ThrottleLevel.HARD,
          reason: `Hard throttle active (week spend $${state.weekSpend.toFixed(2)} / ceiling $${state.weeklyHardCeiling}) — HIGH task downgraded to strategic tier`,
          allowTask: true,
          forceDowngrade: true,
          maxModelTier: 'strategic',
        };
      }
      return {
        level: throttle.level,
        reason: throttle.reason,
        allowTask: true,
        forceDowngrade: false,
        maxModelTier: 'critical',
      };
    }

    // MEDIUM complexity — proceed under none/soft, downgrade under hard
    if (task.complexity === TaskComplexity.MEDIUM) {
      if (throttle.level === ThrottleLevel.HARD) {
        return {
          level: ThrottleLevel.HARD,
          reason: `Hard throttle — MEDIUM task downgraded to fast tier`,
          allowTask: true,
          forceDowngrade: true,
          maxModelTier: 'fast',
        };
      }
      if (throttle.level === ThrottleLevel.SOFT) {
        return {
          level: ThrottleLevel.SOFT,
          reason: `Soft throttle — MEDIUM task proceeds at strategic tier max`,
          allowTask: true,
          forceDowngrade: true,
          maxModelTier: 'strategic',
        };
      }
      return {
        level: ThrottleLevel.NONE,
        reason: 'No throttle — full speed',
        allowTask: true,
        forceDowngrade: false,
        maxModelTier: 'critical',
      };
    }

    // LOW/TRIVIAL — defer under hard throttle, downgrade under soft
    if (throttle.level === ThrottleLevel.HARD) {
      // Check if this is truly a $0.001 call — let it through
      if (estimatedCost < 0.005) {
        return {
          level: ThrottleLevel.HARD,
          reason: 'Hard throttle but cost negligible — allowing',
          allowTask: true,
          forceDowngrade: true,
          maxModelTier: 'fast',
        };
      }
      return {
        level: ThrottleLevel.HARD,
        reason: `Hard throttle — LOW/TRIVIAL task deferred (estimated $${estimatedCost.toFixed(4)})`,
        allowTask: false,
        forceDowngrade: false,
        maxModelTier: 'fast',
      };
    }

    return {
      level: throttle.level,
      reason: throttle.reason,
      allowTask: true,
      forceDowngrade: throttle.level === ThrottleLevel.SOFT,
      maxModelTier: throttle.level === ThrottleLevel.SOFT ? 'fast' : 'critical',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // SURGE DETECTION
  // ─────────────────────────────────────────────────────────────

  /**
   * Check if surge is allowed.
   * 
   * Logic: If it's Thursday or later and week spend is below 60% of target,
   * the bot has been quiet. Allow a surge up to the hard ceiling.
   * This prevents throttling an important reasoning chain just because
   * the bot was idle earlier in the week.
   */
  checkSurgeAllowance(clientId: string, dayOfWeek: number): boolean {
    const state = this.getState(clientId);

    // Thursday = 4, Friday = 5
    if (dayOfWeek >= 4) {
      const spendRatio = state.weekSpend / state.weekTarget;
      if (spendRatio < this.config.surgeThreshold) {
        state.surgeAllowance = true;
        return true;
      }
    }

    return state.surgeAllowance;
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────

  private computeThrottleLevel(state: BudgetState): { level: ThrottleLevel; reason: string } {
    // Monthly budget exhausted — hard throttle
    if (state.remainingMonthly <= 0) {
      return {
        level: ThrottleLevel.HARD,
        reason: `Monthly budget exhausted ($${state.monthSpend.toFixed(2)} / $${state.monthlyBudget})`,
      };
    }

    // Global ceiling hit — hard throttle
    if (this.globalMonthSpend >= this.config.globalMonthlyHardCeiling) {
      return {
        level: ThrottleLevel.HARD,
        reason: `Global monthly ceiling hit ($${this.globalMonthSpend.toFixed(2)} / $${this.config.globalMonthlyHardCeiling})`,
      };
    }

    // Weekly hard ceiling hit — hard throttle (unless surge allowed)
    if (state.weekSpend >= state.weeklyHardCeiling && !state.surgeAllowance) {
      return {
        level: ThrottleLevel.HARD,
        reason: `Weekly hard ceiling hit ($${state.weekSpend.toFixed(2)} / $${state.weeklyHardCeiling})`,
      };
    }

    // Weekly target exceeded but below ceiling — soft throttle
    if (state.weekSpend >= state.weekTarget) {
      return {
        level: ThrottleLevel.SOFT,
        reason: `Weekly target exceeded ($${state.weekSpend.toFixed(2)} / $${state.weekTarget}) — soft throttle, prefer cheaper models`,
      };
    }

    // Monthly spend > 80% — soft throttle as precaution
    if (state.monthSpend > state.monthlyBudget * 0.8) {
      return {
        level: ThrottleLevel.SOFT,
        reason: `Monthly budget 80%+ consumed ($${state.monthSpend.toFixed(2)} / $${state.monthlyBudget}) — soft throttle`,
      };
    }

    return { level: ThrottleLevel.NONE, reason: 'Within budget — no throttle' };
  }

  private getState(clientId: string): BudgetState {
    const state = this.clientStates.get(clientId);
    if (!state) {
      throw new Error(`Client ${clientId} not initialized. Call initClient() first.`);
    }
    return state;
  }

  /**
   * Get current budget state for reporting.
   */
  getClientBudgetReport(clientId: string): BudgetState {
    return { ...this.getState(clientId) };
  }

  /**
   * Get all clients' budget states for dashboard.
   */
  getAllBudgetReports(): BudgetState[] {
    return Array.from(this.clientStates.values()).map(s => ({ ...s }));
  }

  /**
   * Get global spend for operator dashboard.
   */
  getGlobalSpend(): { monthSpend: number; ceiling: number; utilization: number } {
    return {
      monthSpend: this.globalMonthSpend,
      ceiling: this.config.globalMonthlyHardCeiling,
      utilization: this.globalMonthSpend / this.config.globalMonthlyHardCeiling,
    };
  }
}
