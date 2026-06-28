/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * GAP-07 enforcement: executeSurpassPlans unit tests.
 * Verifies that planned gap analyses are dispatched to site-deployment
 * and status is updated to 'executing'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue([]),
});
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockLogAction = vi.fn().mockResolvedValue('action-id-123');
const mockEvaluate = vi.fn().mockReturnValue({ execute: true, reason: 'auto', requiresApproval: false });
const mockCreateProposal = vi.fn().mockImplementation((p) => p);

const mockUpdateMetaTitle = vi.fn().mockResolvedValue({ success: true, dryRun: true });
const mockTriggerDeploy = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'gap-1',
                clientId: 'client-1',
                keyword: 'roofing austin tx',
                clientUrl: 'https://test.com/services/',
                competitorUrl: 'https://comp.com/services/',
                surpassPlan: [
                  { priority: 1, action: 'Update meta title: "Best Roofer Austin TX"', effort: 'low', impact: 'high', autonomous: true, status: 'pending' },
                ],
                status: 'planned',
              },
            ]),
          }),
        }),
      }),
    }),
    update: mockUpdate,
  }),
  schema: { gapAnalyses: {} },
}));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../src/core/execution-policy.js', () => ({
  evaluateExecution: mockEvaluate,
  createProposal: mockCreateProposal,
  logAction: mockLogAction,
}));

vi.mock('../../src/services/site-deployment.js', () => ({
  updateMetaTitle: mockUpdateMetaTitle,
  updateMetaDescription: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  injectSchema: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  updateHeading: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  rewritePageContent: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  updateFaq: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  triggerVercelDeploy: mockTriggerDeploy,
  getSiteDeploymentService: vi.fn(),
}));

describe('executeSurpassPlans — GAP-07', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches meta_title_update action to site-deployment', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockUpdateMetaTitle).toHaveBeenCalledWith(
      'src/pages/services/index.astro',
      'Best Roofer Austin TX',
      'test.com',
    );
  });

  it('triggers Vercel deploy after dispatching actions', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockTriggerDeploy).toHaveBeenCalled();
  });

  it('sets gap status to executing after processing', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'executing' });
  });

  it('logs action through execution-policy before dispatching', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockLogAction).toHaveBeenCalled();
    expect(mockEvaluate).toHaveBeenCalled();
  });
});
