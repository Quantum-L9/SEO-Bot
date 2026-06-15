/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - LLM Service (v2.0 — powered by @l9/llm-router)
 *
 * This module is a thin adapter between the SEO Bot's modules and the shared
 * @l9/llm-router package. It provides:
 *   1. Initialization with env-based config
 *   2. Convenience methods that map old tier-based calls to TaskDescriptor-based routing
 *   3. Budget reporting passthrough
 *   4. Vision QA passthrough
 *   5. Search-grounded (Perplexity) passthrough
 *
 * NO LLM logic lives here. All routing, budget, and provider management is
 * delegated to @l9/llm-router.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  L9LLMRouter,
  TaskType,
  TaskComplexity,
  type TaskDescriptor,
  type LLMResponse,
  type BudgetConfig,
  type RoutingDecision,
  type FullSiteQAConfig,
  type VisualQATask,
  BudgetExhaustedError,
} from '@l9/llm-router';
import { getConfig } from '../core/config.js';
import { createModuleLogger } from '../core/logger.js';
import { getDb, schema } from '../core/database/index.js';
import type { ModuleName } from '../types/index.js';

const logger = createModuleLogger('llm');

// ═══════════════════════════════════════════════════════════════
// MODULE-TO-TASK-TYPE MAPPING
// ═══════════════════════════════════════════════════════════════

/**
 * Maps the old tier-based call pattern to the new TaskDescriptor pattern.
 * This allows modules to migrate incrementally — they can use convenience
 * methods now and switch to direct router.execute() later.
 */
type LegacyTier = 'fast' | 'strategic';

function tierToComplexity(tier: LegacyTier): TaskComplexity {
  return tier === 'fast' ? TaskComplexity.LOW : TaskComplexity.HIGH;
}

// ═══════════════════════════════════════════════════════════════
// THE SERVICE
// ═══════════════════════════════════════════════════════════════

export class LlmService {
  private router: L9LLMRouter;

  constructor() {
    const config = getConfig();

    this.router = new L9LLMRouter({
      perplexityApiKey: config.PERPLEXITY_API_KEY,
      openrouterApiKey: config.OPENROUTER_API_KEY,
      appName: 'L9-SEO-Bot',
      budget: {
        monthlyBudgetPerClient: config.DEFAULT_CLIENT_MONTHLY_BUDGET,
        weeklyTarget: config.DEFAULT_CLIENT_WEEKLY_TARGET,
        weeklyHardCeiling: config.DEFAULT_CLIENT_WEEKLY_CEILING,
        globalMonthlyHardCeiling: config.GLOBAL_MONTHLY_HARD_CEILING,
        surgeThreshold: config.SURGE_THRESHOLD,
      },
    });

    logger.info('LLM Service initialized with @l9/llm-router');
  }

  // ─────────────────────────────────────────────────────────────
  // PRIMARY API: Direct router access (preferred for new code)
  // ─────────────────────────────────────────────────────────────

  /**
   * Direct access to the router for modules that want full control.
   * This is the preferred API for new module code.
   */
  getRouter(): L9LLMRouter {
    return this.router;
  }

  /**
   * Execute a fully-specified task descriptor.
   * Modules that have migrated to TaskDescriptor-based calls use this.
   */
  async execute(
    task: TaskDescriptor,
    systemPrompt: string,
    userPrompt: string,
    options?: { images?: string[]; assistantContext?: string; consensus?: boolean },
  ): Promise<LLMResponse> {
    try {
      const response = await this.router.execute(task, systemPrompt, userPrompt, options);

      // Log to database
      await this.logUsage(task, response);

      return response;
    } catch (error: any) {
      if (error instanceof BudgetExhaustedError) {
        logger.warn({
          clientId: task.clientId,
          taskType: task.type,
          complexity: task.complexity,
          reason: error.message,
        }, 'Task deferred by budget engine');
      } else {
        logger.error({ error: error.message, task: task.description }, 'LLM execution failed');
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CONVENIENCE METHODS (backward-compatible with old module code)
  // ─────────────────────────────────────────────────────────────

  /**
   * Classification — fast, cheap, deterministic.
   * Maps to: TaskType.CLASSIFICATION, TaskComplexity.LOW
   */
  async classify(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.CLASSIFICATION,
        complexity: TaskComplexity.LOW,
        expectedOutputTokens: 100,
        description: `[${module}] ${purpose}`,
      },
      'You are a precise classifier. Respond with only the classification label, no explanation.',
      prompt,
    );
    return response.content.trim();
  }

  /**
   * JSON extraction — fast, structured output.
   * Maps to: TaskType.EXTRACTION, TaskComplexity.LOW-MEDIUM
   */
  async extractJson<T>(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.LOW,
  ): Promise<T> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.EXTRACTION,
        complexity,
        expectedOutputTokens: 1000,
        description: `[${module}] ${purpose}`,
      },
      'You are a precise data extractor. Always respond with valid JSON only. No markdown fences.',
      prompt,
    );
    return JSON.parse(response.content) as T;
  }

  /**
   * Scoring — fast, returns a number.
   * Maps to: TaskType.SCORING, TaskComplexity.LOW
   */
  async score(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
  ): Promise<number> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.SCORING,
        complexity: TaskComplexity.LOW,
        expectedOutputTokens: 50,
        description: `[${module}] ${purpose}`,
      },
      'You are a precise scorer. Respond with only a number between 0 and 100, no explanation.',
      prompt,
    );
    return parseFloat(response.content.trim());
  }

  /**
   * Content generation — strategic, creative.
   * Maps to: TaskType.CONTENT_GENERATION, TaskComplexity.MEDIUM-HIGH
   */
  async generateContent(
    systemPrompt: string,
    userPrompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.CONTENT_GENERATION,
        complexity,
        expectedOutputTokens: 3000,
        description: `[${module}] ${purpose}`,
      },
      systemPrompt,
      userPrompt,
    );
    return response.content;
  }

  /**
   * Strategic reasoning — expensive, used for surpass plans, strategy pivots.
   * Maps to: TaskType.STRATEGIC_REASONING, TaskComplexity.HIGH
   */
  async strategize(
    systemPrompt: string,
    userPrompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.HIGH,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.STRATEGIC_REASONING,
        complexity,
        expectedOutputTokens: 4000,
        requiresReasoning: true,
        description: `[${module}] ${purpose}`,
      },
      systemPrompt,
      userPrompt,
    );
    return response.content;
  }

  /**
   * Search-grounded research — uses Perplexity with web search.
   * Maps to: TaskType.COMPETITOR_RESEARCH | MARKET_RESEARCH | etc.
   */
  async research(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    taskType: TaskType = TaskType.COMPETITOR_RESEARCH,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
    options?: { domainFilter?: string[]; consensus?: boolean },
  ): Promise<LLMResponse> {
    return this.execute(
      {
        clientId,
        type: taskType,
        complexity,
        requiresSearch: true,
        domainFilter: options?.domainFilter,
        description: `[${module}] ${purpose}`,
      },
      'You are an expert SEO researcher. Provide factual, citation-backed answers.',
      prompt,
      { consensus: options?.consensus },
    );
  }

  /**
   * Citation check — uses Perplexity to verify AI search citations.
   * Maps to: TaskType.CITATION_CHECK, TaskComplexity.MEDIUM
   */
  async checkCitation(
    query: string,
    clientId: string,
    targetDomain: string,
  ): Promise<LLMResponse> {
    return this.execute(
      {
        clientId,
        type: TaskType.CITATION_CHECK,
        complexity: TaskComplexity.MEDIUM,
        requiresSearch: true,
        description: `[aeo-geo] Citation check: "${query}" → ${targetDomain}`,
      },
      'Answer the following question naturally and thoroughly. Cite your sources.',
      query,
    );
  }

  /**
   * Visual QA — screenshot analysis for layout validation.
   * Maps to: TaskType.LAYOUT_VALIDATION | VISUAL_QA
   */
  async analyzeScreenshot(
    prompt: string,
    imageUrls: string[],
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.LAYOUT_VALIDATION,
        complexity,
        images: imageUrls,
        description: `[${module}] ${purpose}`,
      },
      'You are a professional web designer and UX expert. Analyze the screenshot for layout issues, misalignment, broken elements, and visual quality.',
      prompt,
      { images: imageUrls },
    );
    return response.content;
  }

  /**
   * Plan a full visual QA audit for a client site.
   */
  planVisualQA(config: FullSiteQAConfig): VisualQATask[] {
    return this.router.planVisualQA(config);
  }

  // ─────────────────────────────────────────────────────────────
  // LEGACY COMPATIBILITY (maps old tier-based calls)
  // ─────────────────────────────────────────────────────────────

  /**
   * @deprecated Use execute() or convenience methods instead.
   * Preserved for modules that haven't migrated yet.
   */
  async call(request: {
    tier: LegacyTier;
    systemPrompt: string;
    userPrompt: string;
    clientId: string;
    module: ModuleName;
    purpose: string;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: 'text' | 'json';
  }): Promise<{ content: string; inputTokens: number; outputTokens: number; cost: number; model: string }> {
    const taskType = request.responseFormat === 'json' ? TaskType.EXTRACTION : TaskType.CONTENT_GENERATION;
    const complexity = tierToComplexity(request.tier);

    const response = await this.execute(
      {
        clientId: request.clientId,
        type: taskType,
        complexity,
        expectedOutputTokens: request.maxTokens,
        description: `[${request.module}] ${request.purpose}`,
      },
      request.systemPrompt,
      request.userPrompt,
    );

    return {
      content: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cost: response.cost,
      model: response.model,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENT MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  initClient(clientId: string, budgetOverrides?: Partial<BudgetConfig>): void {
    this.router.initClient(clientId, budgetOverrides);
    logger.info({ clientId, overrides: budgetOverrides }, 'Client initialized in LLM router');
  }

  // ─────────────────────────────────────────────────────────────
  // BUDGET REPORTING
  // ─────────────────────────────────────────────────────────────

  getClientBudgetReport(clientId: string) {
    return this.router.getClientBudgetReport(clientId);
  }

  getAllBudgetReports() {
    return this.router.getAllBudgetReports();
  }

  getGlobalSpend() {
    return this.router.getGlobalSpend();
  }

  getDailySpend(): number {
    const today = new Date().toISOString().slice(0, 10);
    const log = this.router.getCallLog(1000);
    return log
      .filter(d => d.timestamp.toISOString().slice(0, 10) === today)
      .reduce((sum, d) => sum + d.cost, 0);
  }

  getCallLog(limit: number = 100): RoutingDecision[] {
    return this.router.getCallLog(limit);
  }

  getCallLogByClient(clientId: string, limit: number = 50): RoutingDecision[] {
    return this.router.getCallLogByClient(clientId, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL
  // ─────────────────────────────────────────────────────────────

  private async logUsage(task: TaskDescriptor, response: LLMResponse): Promise<void> {
    try {
      const db = getDb();
      await db.insert(schema.llmUsage).values({
        clientId: task.clientId ?? 'system',
        module: this.extractModule(task.description),
        tier: this.inferTier(task.complexity),
        purpose: task.description ?? 'unspecified',
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cost: response.cost,
      });
    } catch (error: any) {
      // Non-fatal — don't crash the bot over a logging failure
      logger.warn({ error: error.message }, 'Failed to log LLM usage to database');
    }
  }

  private extractModule(description?: string): string {
    if (!description) return 'unknown';
    const match = description.match(/\[([^\]]+)\]/);
    return match ? match[1] : 'unknown';
  }

  private inferTier(complexity: TaskComplexity): string {
    if (complexity <= TaskComplexity.LOW) return 'fast';
    if (complexity <= TaskComplexity.MEDIUM) return 'standard';
    return 'strategic';
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════

let _llmService: LlmService | null = null;

export function getLlmService(): LlmService {
  if (!_llmService) {
    _llmService = new LlmService();
  }
  return _llmService;
}

// Re-export router types for module convenience
export { TaskType, TaskComplexity, BudgetExhaustedError } from '@l9/llm-router';
export type { TaskDescriptor, LLMResponse, RoutingDecision } from '@l9/llm-router';
