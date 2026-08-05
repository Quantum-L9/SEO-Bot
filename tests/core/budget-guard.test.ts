import { describe, it, expect, vi } from 'vitest';

// budget-guard.ts creates a module logger at import (→ getConfig). Stub the
// logger so the guard can be unit-tested without a full config env.
vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  AgentBudgetGuard,
  AdmissionRejectedError,
  BudgetExceededError,
} from '../../src/core/budget-guard.js';

describe('AgentBudgetGuard', () => {
  it('admits a job whose forecast fits under the cap', () => {
    const guard = new AgentBudgetGuard('job-1', 2.0, 'client-1');
    expect(() => guard.open(1.5)).not.toThrow();
    expect(guard.currentMode).toBe('normal');
  });

  it('rejects admission when the initial forecast exceeds the cap', () => {
    const guard = new AgentBudgetGuard('job-2', 2.0);
    expect(() => guard.open(2.5)).toThrow(AdmissionRejectedError);
  });

  it('reconciles actual spend and surfaces it via enforce()', () => {
    const guard = new AgentBudgetGuard('job-3', 2.0, 'client-3');
    guard.open(0);
    guard.reserve(0.5);
    guard.reconcile(0.4);
    const snapshot = guard.enforce();
    expect(snapshot.actualUsd).toBeCloseTo(0.4, 6);
    expect(snapshot.remainingUsd).toBeCloseTo(1.6, 6);
    expect(snapshot.clientId).toBe('client-3');
  });

  it('escalates mode as spend pressure crosses ADR-0008 thresholds', () => {
    const guard = new AgentBudgetGuard('job-4', 1.0);
    guard.open(0);
    // actual 0.8 (80% pressure, the 70–85% band → cheaper_model) with a next
    // estimate that pushes forecast over the cap, which triggers reconcile()'s
    // mode recompute without the actual spend itself exceeding the cap.
    guard.reconcile(0.8, 0.3);
    expect(guard.currentMode).toBe('cheaper_model');
  });

  it('throws BudgetExceededError when reconciled spend passes the cap', () => {
    const guard = new AgentBudgetGuard('job-5', 1.0);
    guard.open(0);
    expect(() => guard.reconcile(1.25)).toThrow(BudgetExceededError);
  });

  it('enforce() throws once the cap is fully exhausted', () => {
    const guard = new AgentBudgetGuard('job-6', 1.0);
    guard.open(0);
    // reconcile exactly to the cap: reconcile itself does not throw at ==cap,
    // but enforce() treats zero remaining as exhausted.
    guard.reconcile(1.0);
    expect(() => guard.enforce()).toThrow(BudgetExceededError);
  });
});
