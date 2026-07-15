/**
 * AgentBudgetGuard — four-move runtime budget control loop for SEO Bot.
 *
 * Aligns with the existing TokenBudget policy in src/core/scheduler.ts.
 * Per-client budget caps (maxFastTokensPerRun, maxStrategicTokensPerRun) remain
 * the primary per-job controls — this guard adds USD-level tracking for cross-client
 * aggregate spend and GitHub Actions workflow-level cost caps.
 *
 * Moves: Open (admission) → Reserve → Reconcile → Enforce
 */

import { getConfig } from './config.js';
import { logger } from './logger.js';

export class BudgetExceededError extends Error {}
export class AdmissionRejectedError extends Error {}

export type BudgetMode = 'normal' | 'cheaper_model' | 'narrow_scope' | 'require_approval' | 'stop';

export interface BudgetEnforcement {
  jobId: string;
  clientId?: string;
  mode: BudgetMode;
  actualUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  forecastUsd: number;
}

export class AgentBudgetGuard {
  private capUsd: number;
  private actualUsd = 0;
  private reservedUsd = 0;
  private forecastUsd = 0;
  private mode: BudgetMode = 'normal';

  constructor(
    public readonly jobId: string,
    capUsd: number,
    public readonly clientId?: string,
  ) {
    this.capUsd = capUsd;
  }

  /** MOVE 1 — Admission: verify forecast is feasible before enqueueing. */
  open(initialForecastUsd = 0): void {
    this.forecastUsd = initialForecastUsd;
    if (this.forecastUsd > this.capUsd) {
      throw new AdmissionRejectedError(
        `Admission rejected for job=${this.jobId} client=${this.clientId}: forecast $${this.forecastUsd.toFixed(4)} > cap $${this.capUsd.toFixed(4)}`,
      );
    }
    logger.info({ jobId: this.jobId, clientId: this.clientId, capUsd: this.capUsd }, 'budget_guard:opened');
  }

  /** MOVE 2 — Reserve: lock budget before each LLM call or API call with token cost. */
  reserve(estimatedUsd: number): void {
    const remaining = this.capUsd - this.actualUsd - this.reservedUsd;
    if (estimatedUsd > remaining) {
      this._updateMode();
      const remainingAfterMode = this.capUsd - this.actualUsd - this.reservedUsd;
      if (estimatedUsd > remainingAfterMode) {
        throw new BudgetExceededError(
          `Reservation denied for job=${this.jobId}: need $${estimatedUsd.toFixed(4)}, remaining $${remainingAfterMode.toFixed(4)}, mode=${this.mode}`,
        );
      }
    }
    this.reservedUsd += estimatedUsd;
    this.forecastUsd = this.actualUsd + this.reservedUsd;
  }

  /** MOVE 3 — Reconcile: record actual spend after each step. */
  reconcile(actualUsd: number, nextEstimateUsd = 0): void {
    this.actualUsd += actualUsd;
    this.reservedUsd = Math.max(0, this.reservedUsd - actualUsd);
    this.forecastUsd = this.actualUsd + this.reservedUsd + nextEstimateUsd;
    logger.debug({ jobId: this.jobId, actualUsd: this.actualUsd, forecastUsd: this.forecastUsd }, 'budget_guard:reconciled');
    if (this.actualUsd > this.capUsd) {
      throw new BudgetExceededError(
        `Budget cap $${this.capUsd.toFixed(4)} exceeded for job=${this.jobId}: actual=$${this.actualUsd.toFixed(4)}`,
      );
    }
    if (this.forecastUsd > this.capUsd) this._updateMode();
  }

  /** MOVE 4 — Enforce: return state snapshot; throws if cap is fully exhausted. */
  enforce(): BudgetEnforcement {
    const remaining = this.capUsd - this.actualUsd;
    if (remaining <= 0) {
      this.mode = 'stop';
      throw new BudgetExceededError(
        `Cap exhausted for job=${this.jobId}: actual=$${this.actualUsd.toFixed(4)}, cap=$${this.capUsd.toFixed(4)}`,
      );
    }
    return {
      jobId: this.jobId,
      clientId: this.clientId,
      mode: this.mode,
      actualUsd: this.actualUsd,
      reservedUsd: this.reservedUsd,
      remainingUsd: remaining,
      forecastUsd: this.forecastUsd,
    };
  }

  get currentMode(): BudgetMode {
    return this.mode;
  }

  private _updateMode(): void {
    const pressure = this.capUsd === 0 ? 1 : (this.actualUsd + this.reservedUsd) / this.capUsd;
    if (pressure < 0.70) this.mode = 'normal';
    else if (pressure < 0.85) this.mode = 'cheaper_model';
    else if (pressure < 0.95) this.mode = 'narrow_scope';
    else if (pressure < 1.00) this.mode = 'require_approval';
    else this.mode = 'stop';
    logger.warn({ jobId: this.jobId, mode: this.mode, pressure: pressure.toFixed(3) }, 'budget_guard:mode_changed');
  }
}
