import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 3: AgentBudgetGuard wired onto the LLM USD cost seam in LlmService.
// These tests drive execute() with the router mocked so route().estimatedCost
// (pre-dispatch reserve) and response.cost (post-dispatch reconcile) are the
// real, controlled USD signals the guard enforces against.

const baseConfig = {
  PERPLEXITY_API_KEY: 'pk',
  OPENROUTER_API_KEY: 'ok',
  DEFAULT_CLIENT_MONTHLY_BUDGET: 100,
  DEFAULT_CLIENT_WEEKLY_TARGET: 25,
  DEFAULT_CLIENT_WEEKLY_CEILING: 40,
  GLOBAL_MONTHLY_HARD_CEILING: 1000,
  SURGE_THRESHOLD: 1.5,
  DAILY_SPEND_CAP: 5,
};

const mockGetConfig = vi.fn(() => ({ ...baseConfig }));

vi.mock('../../src/core/config.js', () => ({
  getConfig: () => mockGetConfig(),
}));

vi.mock('../../src/core/logger.js', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// getDb() is only touched by logUsage() here; give it a no-op insert chain.
vi.mock('../../src/core/database/index.js', () => ({
  getDb: () => ({ insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }) }),
  schema: { llmUsage: {} },
}));

vi.mock('@quantum-l9/llm-router', () => {
  class L9LLMRouter {
    route = vi.fn();
    execute = vi.fn();
    getCallLog = vi.fn(() => []);
    initClient = vi.fn();
  }
  class BudgetExhaustedError extends Error {}
  return {
    L9LLMRouter,
    TaskType: { STRATEGIC_REASONING: 'strategic_reasoning' },
    TaskComplexity: { LOW: 0, MEDIUM: 1, HIGH: 2 },
    BudgetExhaustedError,
  };
});

import { LlmService, DailyBudgetExhaustedError } from '../../src/services/llm.js';

const task = { clientId: 'client-1', type: 'strategic_reasoning', complexity: 2, description: '[serp] test' } as any;

function response(cost: number) {
  return { content: 'ok', cost, inputTokens: 10, outputTokens: 20, model: 'm', provider: 'openrouter' };
}

describe('LlmService daily budget guard (ADR-0008)', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue({ ...baseConfig });
  });

  it('admits a call under the cap and reconciles the real response cost', async () => {
    const svc = new LlmService();
    vi.spyOn(svc, 'getDailySpend').mockResolvedValue(1.0);
    (svc as any).router.route.mockReturnValue({ estimatedCost: 0.1 });
    (svc as any).router.execute.mockResolvedValue(response(0.12));

    const result = await svc.execute(task, 'sys', 'user');

    expect(result.cost).toBe(0.12);
    expect((svc as any).router.execute).toHaveBeenCalledTimes(1);
    expect(svc.getBudgetMode()).toBe('normal');
  });

  it('defers before dispatch when the day already reached the cap', async () => {
    const svc = new LlmService();
    vi.spyOn(svc, 'getDailySpend').mockResolvedValue(5.0); // == cap
    (svc as any).router.route.mockReturnValue({ estimatedCost: 0.1 });
    (svc as any).router.execute.mockResolvedValue(response(0.1));

    await expect(svc.execute(task, 'sys', 'user')).rejects.toBeInstanceOf(DailyBudgetExhaustedError);
    expect((svc as any).router.execute).not.toHaveBeenCalled();
    expect(svc.getBudgetMode()).toBe('stop');
  });

  it('defers pre-emptively when the estimated call would push spend over the cap', async () => {
    const svc = new LlmService();
    vi.spyOn(svc, 'getDailySpend').mockResolvedValue(4.95);
    (svc as any).router.route.mockReturnValue({ estimatedCost: 0.2 }); // 4.95 + 0.2 > 5
    (svc as any).router.execute.mockResolvedValue(response(0.2));

    await expect(svc.execute(task, 'sys', 'user')).rejects.toBeInstanceOf(DailyBudgetExhaustedError);
    // Never spent: the guard rejected the reservation before dispatch.
    expect((svc as any).router.execute).not.toHaveBeenCalled();
    expect(svc.getBudgetMode()).toBe('stop');
  });

  it('does not enforce when DAILY_SPEND_CAP is unset (guard inert)', async () => {
    mockGetConfig.mockReturnValue({ ...baseConfig, DAILY_SPEND_CAP: undefined });
    const svc = new LlmService();
    const spendSpy = vi.spyOn(svc, 'getDailySpend').mockResolvedValue(999);
    (svc as any).router.route.mockReturnValue({ estimatedCost: 0.1 });
    (svc as any).router.execute.mockResolvedValue(response(0.1));

    const result = await svc.execute(task, 'sys', 'user');

    expect(result.cost).toBe(0.1);
    expect((svc as any).router.execute).toHaveBeenCalledTimes(1);
    // Cap disabled ⇒ the guard short-circuits before even reading daily spend.
    expect(spendSpy).not.toHaveBeenCalled();
  });
});
