/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

/**
 * GAP-07 enforcement: executeSurpassPlans unit tests.
 * Verifies that planned gap analyses are dispatched to site-deployment
 * and status is updated to 'executing'.
 *
 * MT (multi-tenant) coverage: the per-client `site_deployment` config resolves
 * from `job.data.clientConfig` and threads through every dispatch + the final
 * Vercel deploy; an unconfigured client falls back to dry-run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable gap fixture — each test sets what the "planned" query returns.
let mockGaps: any[] = [];

const metaTitleGap = () => ({
  id: 'gap-1',
  clientId: 'client-1',
  keyword: 'roofing austin tx',
  clientUrl: 'https://test.com/services/',
  competitorUrl: 'https://comp.com/services/',
  surpassPlan: [
    { priority: 1, action: 'Update meta title: "Best Roofer Austin TX"', effort: 'low', impact: 'high', autonomous: true, status: 'pending' },
  ],
  status: 'planned',
});

const faqGap = () => ({
  id: 'gap-faq',
  clientId: 'client-1',
  keyword: 'what does supplemental insurance cover',
  clientUrl: 'https://test.com/faq/',
  competitorUrl: 'https://comp.com/faq/',
  surpassPlan: [
    { priority: 1, action: 'Add FAQ content answering common questions', effort: 'low', impact: 'high', autonomous: true, status: 'pending' },
  ],
  status: 'planned',
});

const mockUpdateSet = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue([]),
});
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

const mockLogAction = vi.fn().mockResolvedValue('action-id-123');
const mockEvaluate = vi.fn().mockReturnValue({ execute: true, reason: 'auto', requiresApproval: false });
const mockCreateProposal = vi.fn().mockImplementation((p) => p);

const mockUpdateMetaTitle = vi.fn().mockResolvedValue({ success: true, dryRun: true });
const mockUpdateFaq = vi.fn().mockResolvedValue({ success: true, dryRun: true });
const mockInjectSchema = vi.fn().mockResolvedValue({ success: true, dryRun: true });
const mockTriggerDeploy = vi.fn().mockResolvedValue(undefined);

// Mirror the real dry-run guard: absent OR blank token/repo ⇒ dryRun.
const mockSiteConfigFromClient = vi.fn((clientConfig: any) => {
  const sd = clientConfig?.site_deployment;
  const githubToken = sd?.githubToken ?? '';
  const websiteBotRepo = sd?.websiteBotRepo ?? '';
  return {
    githubToken,
    vercelDeployHook: sd?.vercelDeployHook ?? '',
    websiteBotRepo,
    sourceBranch: sd?.sourceBranch || 'main',
    dryRun: !githubToken || !websiteBotRepo,
  };
});

vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            // Plain fn (not a mock) so vi.clearAllMocks() can't drop the impl.
            limit: () => Promise.resolve(mockGaps),
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
  injectSchema: mockInjectSchema,
  updateHeading: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  rewritePageContent: vi.fn().mockResolvedValue({ success: true, dryRun: true }),
  updateFaq: mockUpdateFaq,
  triggerVercelDeploy: mockTriggerDeploy,
  getSiteDeploymentService: vi.fn(),
  siteConfigFromClient: mockSiteConfigFromClient,
}));

describe('executeSurpassPlans — GAP-07', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGaps = [metaTitleGap()];
  });

  it('dispatches meta_title_update action to site-deployment', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    // 4th arg is the per-client siteConfig (dry-run: no clientConfig on the job).
    expect(mockUpdateMetaTitle).toHaveBeenCalledWith(
      'src/pages/services/index.astro',
      'Best Roofer Austin TX',
      'test.com',
      expect.objectContaining({ dryRun: true }),
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

  // ─── MT: multi-tenant site_deployment threading ──────────────────────────────

  it('routes a configured client\'s edit to THAT client\'s repo (live config)', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const clientConfig = {
      site_deployment: {
        githubToken: 'ghp_client1',
        websiteBotRepo: 'Quantum-L9/client1-site',
        vercelDeployHook: 'https://hook.vercel/client1',
        sourceBranch: 'main',
      },
    };
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com', clientConfig } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockSiteConfigFromClient).toHaveBeenCalledWith(clientConfig);
    expect(mockUpdateMetaTitle).toHaveBeenCalledWith(
      'src/pages/services/index.astro',
      'Best Roofer Austin TX',
      'test.com',
      expect.objectContaining({ websiteBotRepo: 'Quantum-L9/client1-site', dryRun: false }),
    );
    // Final deploy fires against the same per-client target.
    expect(mockTriggerDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ websiteBotRepo: 'Quantum-L9/client1-site', dryRun: false }),
    );
  });

  it('falls back to dry-run when the client has no site_deployment', async () => {
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com', clientConfig: {} } } as any;

    await executeSurpassPlans(mockJob);

    expect(mockUpdateMetaTitle).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('does NOT dispatch a write for faq_content_update (G3 — no FAQ payload)', async () => {
    mockGaps = [faqGap()];
    const { executeSurpassPlans } = await import('../../src/services/plan-executor.js');
    const mockJob = { data: { clientId: 'client-1', clientDomain: 'test.com' } } as any;

    await executeSurpassPlans(mockJob);

    // The faq dispatcher is a documented no-op: neither updateFaq nor injectSchema runs.
    expect(mockUpdateFaq).not.toHaveBeenCalled();
    expect(mockInjectSchema).not.toHaveBeenCalled();
    expect(mockUpdateMetaTitle).not.toHaveBeenCalled();
  });
});
