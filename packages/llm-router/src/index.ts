/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/index.ts
 * @purpose Main entry point — the unified LLM Router that all L9 bots consume
 * @pattern TaskDescriptor → Router → Provider Client → LLMResponse
 * @consumers l9-seo-bot, l9-website-factory, future bots
 */

import {
  TaskDescriptor,
  TaskType,
  TaskComplexity,
  LLMResponse,
  Provider,
  BudgetConfig,
  GeneralModel,
  SonarModel,
  RouterConfig,
  RoutingDecision,
} from './types.js';
import { resolvePerplexityConfig } from './matrices/perplexity-matrix.js';
import { resolveGeneralConfig, getFallbackChain } from './matrices/general-matrix.js';
import { BudgetTracker, ThrottleLevel } from './budget/index.js';
import { PerplexityClient } from './providers/perplexity.js';
import { OpenRouterClient } from './providers/openrouter.js';
import {
  resolveVisionConfig,
  generateFullSiteQAPlan,
  VIEWPORTS,
  type FullSiteQAConfig,
  type VisualQATask,
} from './vision/index.js';

// ═══════════════════════════════════════════════════════════════
// SEARCH TASK TYPES (routed to Perplexity)
// ═══════════════════════════════════════════════════════════════

const SEARCH_TASK_TYPES: Set<TaskType> = new Set([
  TaskType.COMPETITOR_RESEARCH,
  TaskType.CITATION_CHECK,
  TaskType.FACT_VERIFICATION,
  TaskType.MARKET_RESEARCH,
  TaskType.LINK_PROSPECTING,
]);

// ═══════════════════════════════════════════════════════════════
// VISION TASK TYPES (routed to vision models)
// ═══════════════════════════════════════════════════════════════

const VISION_TASK_TYPES: Set<TaskType> = new Set([
  TaskType.VISUAL_QA,
  TaskType.SCREENSHOT_ANALYSIS,
  TaskType.LAYOUT_VALIDATION,
]);

// ═══════════════════════════════════════════════════════════════
// THE ROUTER
// ═══════════════════════════════════════════════════════════════

export class L9LLMRouter {
  private budget: BudgetTracker;
  private perplexity: PerplexityClient;
  private openrouter: OpenRouterClient;
  private callLog: RoutingDecision[] = [];

  constructor(config: RouterConfig) {
    this.budget = new BudgetTracker(config.budget);
    this.perplexity = new PerplexityClient(config.perplexityApiKey);
    this.openrouter = new OpenRouterClient(config.openrouterApiKey, config.appName);
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN ENTRY POINT
  // ─────────────────────────────────────────────────────────────

  /**
   * Route a task to the optimal model and execute it.
   * This is the ONLY method consuming bots need to call.
   * 
   * @example
   * const response = await router.execute({
   *   clientId: 'safehavenrr',
   *   type: TaskType.CONTENT_GENERATION,
   *   complexity: TaskComplexity.MEDIUM,
   *   description: 'Write a blog post about roof repair costs',
   * }, systemPrompt, userPrompt);
   */
  async execute(
    task: TaskDescriptor,
    systemPrompt: string,
    userPrompt: string,
    options?: {
      images?: string[];
      assistantContext?: string;
      consensus?: boolean;
    },
  ): Promise<LLMResponse> {
    const decision = this.route(task);

    // Check budget
    const throttle = this.budget.evaluateTask(
      task.clientId,
      task,
      decision.estimatedCost,
    );

    if (!throttle.allowTask) {
      throw new BudgetExhaustedError(
        `Task deferred: ${throttle.reason}`,
        task,
        decision,
      );
    }

    // Apply model downgrade if throttled
    if (throttle.forceDowngrade) {
      decision.downgraded = true;
      decision.downgradedFrom = decision.model;
      decision.model = this.getDowngradedModel(decision.model, throttle.maxModelTier);
    }

    // Execute based on provider
    let response: LLMResponse;

    if (decision.provider === Provider.PERPLEXITY) {
      const config = resolvePerplexityConfig(task);

      if (options?.consensus && config.variations > 1) {
        const result = await this.perplexity.completeWithConsensus(
          config,
          systemPrompt,
          userPrompt,
          options.assistantContext,
        );
        response = result.best;
      } else {
        response = await this.perplexity.complete(
          config,
          systemPrompt,
          userPrompt,
          options?.assistantContext,
        );
      }
    } else if (VISION_TASK_TYPES.has(task.type) && options?.images?.length) {
      const visionConfig = resolveVisionConfig(
        task.type as TaskType.VISUAL_QA | TaskType.SCREENSHOT_ANALYSIS | TaskType.LAYOUT_VALIDATION,
        task.complexity,
        options.images.length,
      );
      response = await this.openrouter.completeWithVision(
        visionConfig,
        systemPrompt,
        userPrompt,
        options.images,
      );
    } else {
      const config = resolveGeneralConfig(task);
      const fallbacks = getFallbackChain(config.model);
      response = await this.openrouter.completeWithFallback(
        config,
        fallbacks,
        systemPrompt,
        userPrompt,
      );
    }

    // Record spend
    this.budget.recordSpend(task.clientId, response.cost);

    // Log the routing decision
    decision.actualCost = response.cost;
    decision.latencyMs = response.latencyMs;
    this.callLog.push(decision);

    return response;
  }

  // ─────────────────────────────────────────────────────────────
  // ROUTING LOGIC (deterministic, no LLM call)
  // ─────────────────────────────────────────────────────────────

  /**
   * Determine routing without executing.
   * Useful for cost estimation and planning.
   */
  route(task: TaskDescriptor): RoutingDecision {
    // Search tasks → Perplexity
    if (SEARCH_TASK_TYPES.has(task.type)) {
      const config = resolvePerplexityConfig(task);
      return {
        taskId: task.id ?? crypto.randomUUID(),
        clientId: task.clientId,
        taskType: task.type,
        complexity: task.complexity,
        provider: Provider.PERPLEXITY,
        model: config.model,
        estimatedCost: config.estimatedCostPerCall,
        reason: config.resolutionReason,
        timestamp: new Date().toISOString(),
      };
    }

    // Vision tasks → OpenRouter with vision model
    if (VISION_TASK_TYPES.has(task.type)) {
      const config = resolveVisionConfig(
        task.type as TaskType.VISUAL_QA | TaskType.SCREENSHOT_ANALYSIS | TaskType.LAYOUT_VALIDATION,
        task.complexity,
      );
      return {
        taskId: task.id ?? crypto.randomUUID(),
        clientId: task.clientId,
        taskType: task.type,
        complexity: task.complexity,
        provider: Provider.OPENROUTER,
        model: config.model,
        estimatedCost: config.estimatedCostPerCall,
        reason: config.resolutionReason,
        timestamp: new Date().toISOString(),
      };
    }

    // Everything else → OpenRouter general matrix
    const config = resolveGeneralConfig(task);
    return {
      taskId: task.id ?? crypto.randomUUID(),
      clientId: task.clientId,
      taskType: task.type,
      complexity: task.complexity,
      provider: Provider.OPENROUTER,
      model: config.model,
      estimatedCost: config.estimatedCostPerCall,
      reason: config.resolutionReason,
      timestamp: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENT MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  initClient(clientId: string, budgetOverrides?: Partial<BudgetConfig>): void {
    this.budget.initClient(clientId, budgetOverrides);
  }

  resetDaily(clientId: string): void {
    this.budget.resetDaily(clientId);
  }

  resetWeekly(clientId: string): void {
    this.budget.resetWeekly(clientId);
  }

  resetMonthly(clientId: string): void {
    this.budget.resetMonthly(clientId);
  }

  // ─────────────────────────────────────────────────────────────
  // REPORTING
  // ─────────────────────────────────────────────────────────────

  getClientBudgetReport(clientId: string) {
    return this.budget.getClientBudgetReport(clientId);
  }

  getAllBudgetReports() {
    return this.budget.getAllBudgetReports();
  }

  getGlobalSpend() {
    return this.budget.getGlobalSpend();
  }

  getCallLog(limit: number = 100): RoutingDecision[] {
    return this.callLog.slice(-limit);
  }

  getCallLogByClient(clientId: string, limit: number = 50): RoutingDecision[] {
    return this.callLog
      .filter(d => d.clientId === clientId)
      .slice(-limit);
  }

  // ─────────────────────────────────────────────────────────────
  // VISION QA HELPERS (convenience methods for consuming bots)
  // ─────────────────────────────────────────────────────────────

  /**
   * Generate a full-site visual QA plan.
   * The consuming bot takes the screenshots and calls execute() for each task.
   */
  planVisualQA(config: FullSiteQAConfig): VisualQATask[] {
    return generateFullSiteQAPlan(config);
  }

  getViewports() {
    return VIEWPORTS;
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────

  private getDowngradedModel(
    original: GeneralModel | SonarModel | string,
    maxTier: 'fast' | 'strategic' | 'critical',
  ): GeneralModel | SonarModel | string {
    if (maxTier === 'fast') {
      return GeneralModel.GPT4O_MINI;
    }
    if (maxTier === 'strategic') {
      // If original was critical tier, downgrade to strategic
      if (
        original === GeneralModel.CLAUDE_OPUS ||
        original === GeneralModel.O1 ||
        original === GeneralModel.O3
      ) {
        return GeneralModel.CLAUDE_SONNET;
      }
    }
    return original; // No downgrade needed
  }
}

// ═══════════════════════════════════════════════════════════════
// ERROR TYPES
// ═══════════════════════════════════════════════════════════════

export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public task: TaskDescriptor,
    public decision: RoutingDecision,
  ) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

// ═══════════════════════════════════════════════════════════════
// RE-EXPORTS (consuming bots import everything from here)
// ═══════════════════════════════════════════════════════════════

export {
  TaskType,
  TaskComplexity,
  TaskDescriptor,
  LLMResponse,
  Provider,
  GeneralModel,
  SonarModel,
  BudgetConfig,
  RouterConfig,
  RoutingDecision,
} from './types.js';

export { BudgetTracker, ThrottleLevel } from './budget/index.js';
export { resolvePerplexityConfig } from './matrices/perplexity-matrix.js';
export { resolveGeneralConfig, getFallbackChain } from './matrices/general-matrix.js';
export { resolveVisionConfig, VIEWPORTS, VISUAL_QA_PROMPTS } from './vision/index.js';
export type { FullSiteQAConfig, VisualQATask, ViewportConfig } from './vision/index.js';
