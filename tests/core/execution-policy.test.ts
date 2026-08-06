/* L9_META
 * layer: test
 * role: core_unit_test
 * status: active
 */

/**
 * GAP-001 — Critical-action approval boundary.
 *
 * The execution policy is the ONLY gate between an autonomous action and the
 * live site. `evaluateExecution` auto-executes low/medium/high and holds ONLY
 * `critical`. The pre-existing suite never exercised the real policy (the
 * plan-executor test mocks `evaluateExecution`), so a mutation that let a
 * `critical` action auto-execute — e.g. `if (riskLevel === 'critical') return
 * { execute: true }` — would ship green. These tests pin the boundary directly:
 * every risk level, the unknown-action fallback, each critical taxonomy entry,
 * and the persisted `pending_approval` status on denial.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB + logger stubs (logAction/approve/reject persist decisions) ─────────────
const insertReturningMock = vi.fn().mockResolvedValue([{ id: 'action-uuid-1' }]);
const insertValuesMock = vi.fn(() => ({ returning: insertReturningMock }));
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateWhereMock = vi.fn().mockResolvedValue([]);
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({ insert: insertMock, update: updateMock }),
  // Column handles only need to be distinguishable objects for eq()/set().
  schema: { actionLog: { id: 'actionLog.id', status: 'actionLog.status', clientId: 'actionLog.clientId', createdAt: 'actionLog.createdAt' } },
}));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  evaluateExecution,
  classifyAction,
  createProposal,
  logAction,
  approveAction,
  rejectAction,
  type ActionProposal,
  type RiskLevel,
} from '../../src/core/execution-policy.js';

function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    clientId: 'client-1',
    module: 'serp-intelligence',
    action: 'meta_title_update',
    description: 'Update the meta title',
    rationale: 'competitor overtook position #1',
    triggeredBy: 'competitor:roofingpros.com',
    riskLevel: 'low',
    reversible: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertReturningMock.mockResolvedValue([{ id: 'action-uuid-1' }]);
  updateWhereMock.mockResolvedValue([]);
});

describe('evaluateExecution — the approval boundary (GAP-001)', () => {
  it('NEVER auto-executes a critical action', () => {
    const decision = evaluateExecution(proposal({ riskLevel: 'critical', action: 'site_redesign' }));
    expect(decision.execute).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain('CRITICAL');
  });

  it.each<RiskLevel>(['low', 'medium', 'high'])(
    'auto-executes a %s action without approval',
    (riskLevel) => {
      const decision = evaluateExecution(proposal({ riskLevel }));
      expect(decision.execute).toBe(true);
      expect(decision.requiresApproval).toBe(false);
    },
  );

  it('is the only gate: even irreversible high-risk still auto-executes', () => {
    // page_deletion is high + irreversible; policy still auto-executes (backups).
    const decision = evaluateExecution(proposal({ riskLevel: 'high', reversible: false, action: 'page_deletion' }));
    expect(decision.execute).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });
});

describe('classifyAction — taxonomy + fallback (GAP-001)', () => {
  it.each([
    'site_redesign',
    'seo_strategy_overhaul',
    'domain_migration',
    'domain_change',
    'bulk_page_delete',
    'bulk_redirect_change',
    'hosting_migration',
  ])('keeps %s classified as critical (must never drift to auto-execute)', (action) => {
    const { riskLevel } = classifyAction(action);
    expect(riskLevel).toBe('critical');
    // And the boundary agrees: a critical classification is held for approval.
    expect(evaluateExecution(proposal({ riskLevel, action })).requiresApproval).toBe(true);
  });

  it('classifies representative low/medium/high actions per the authored taxonomy', () => {
    expect(classifyAction('meta_description_update')).toEqual({ riskLevel: 'low', reversible: true });
    expect(classifyAction('content_rewrite')).toEqual({ riskLevel: 'medium', reversible: true });
    expect(classifyAction('page_deletion')).toEqual({ riskLevel: 'high', reversible: false });
    expect(classifyAction('citation_submission')).toEqual({ riskLevel: 'low', reversible: false });
  });

  it('falls back to medium/reversible (auto-execute) for an unknown action', () => {
    const classification = classifyAction('totally_new_action_type');
    expect(classification).toEqual({ riskLevel: 'medium', reversible: true });
    // The fallback must NOT be critical — an unknown action auto-executes.
    expect(evaluateExecution(proposal({ ...classification, action: 'totally_new_action_type' })).execute).toBe(true);
  });

  it('createProposal stamps the classified risk/reversibility onto the proposal', () => {
    const p = createProposal({
      clientId: 'c1', module: 'links', action: 'domain_migration',
      description: 'move domains', rationale: 'rebrand', triggeredBy: 'operator',
    });
    expect(p.riskLevel).toBe('critical');
    expect(p.reversible).toBe(false);
  });
});

describe('logAction — persisted status reflects the decision (GAP-001)', () => {
  it('persists pending_approval when execution is denied (critical)', async () => {
    const p = createProposal({
      clientId: 'c1', module: 'serp', action: 'site_redesign',
      description: 'redesign', rationale: 'overhaul', triggeredBy: 'operator',
    });
    const decision = evaluateExecution(p);
    const id = await logAction(p, decision);

    expect(id).toBe('action-uuid-1');
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({
      status: 'pending_approval',
      riskLevel: 'critical',
      action: 'site_redesign',
    });
  });

  it('persists auto_executed when execution is allowed', async () => {
    const p = proposal({ riskLevel: 'low', action: 'meta_title_update' });
    await logAction(p, evaluateExecution(p));
    expect(insertValuesMock.mock.calls[0][0]).toMatchObject({ status: 'auto_executed' });
  });
});

describe('approveAction / rejectAction — resolve a single action (GAP-001)', () => {
  it('approveAction sets status=approved for exactly the given id', async () => {
    await approveAction('action-uuid-1');
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock.mock.calls[0][0]).toMatchObject({ status: 'approved' });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });

  it('rejectAction sets status=rejected for exactly the given id', async () => {
    await rejectAction('action-uuid-1');
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock.mock.calls[0][0]).toMatchObject({ status: 'rejected' });
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});
