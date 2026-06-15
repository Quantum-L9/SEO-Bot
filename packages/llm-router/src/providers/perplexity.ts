/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/providers/perplexity.ts
 * @purpose Perplexity API client — handles all search-grounded LLM calls
 * @api https://api.perplexity.ai/chat/completions
 */

import OpenAI from 'openai';
import {
  PerplexityConfig,
  LLMResponse,
  Provider,
  MessageStrategy,
  SonarModel,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════
// CLIENT
// ═══════════════════════════════════════════════════════════════

export class PerplexityClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.perplexity.ai',
    });
  }

  /**
   * Execute a search-grounded completion using the resolved PerplexityConfig.
   */
  async complete(
    config: PerplexityConfig,
    systemPrompt: string,
    userPrompt: string,
    assistantContext?: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    // Build messages based on strategy
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    messages.push({ role: 'system', content: systemPrompt });

    if (config.messageStrategy === MessageStrategy.SYSTEM_USER_ASSISTANT && assistantContext) {
      messages.push({ role: 'assistant', content: assistantContext });
    }

    messages.push({ role: 'user', content: userPrompt });

    // Build request body
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      web_search_options: {
        search_context_size: config.searchContextSize,
      },
    };

    // Add response format if JSON
    if (!config.disableSearch) {
      // Search is enabled by default for Perplexity
    }

    // Add recency filter
    if (config.recencyFilter !== 'none') {
      (requestBody.web_search_options as Record<string, unknown>).search_recency_filter =
        config.recencyFilter;
    }

    // Add domain filter
    if (config.domainFilter.length > 0) {
      (requestBody.web_search_options as Record<string, unknown>).search_domain_filter =
        config.domainFilter;
    }

    // Add search mode if not web (default)
    if (config.searchMode !== 'web') {
      requestBody.search_mode = config.searchMode;
    }

    // Add reasoning effort for reasoning models
    if (config.reasoningEffort && isReasoningModel(config.model)) {
      requestBody.reasoning_effort = config.reasoningEffort;
    }

    try {
      const response = await this.client.chat.completions.create(
        requestBody as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      );

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      return {
        content: choice?.message?.content ?? '',
        model: config.model,
        provider: Provider.PERPLEXITY,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        cost: this.calculateActualCost(config, response.usage),
        latencyMs,
        cached: false,
        citations: (response as unknown as { citations?: string[] }).citations,
      };
    } catch (error) {
      throw new PerplexityError(
        `Perplexity API call failed: ${error instanceof Error ? error.message : String(error)}`,
        config,
      );
    }
  }

  /**
   * Execute with consensus mode (multiple variations).
   * Returns the best response based on consistency.
   */
  async completeWithConsensus(
    config: PerplexityConfig,
    systemPrompt: string,
    userPrompt: string,
    assistantContext?: string,
  ): Promise<{ best: LLMResponse; all: LLMResponse[]; consensusScore: number }> {
    if (config.variations <= 1) {
      const result = await this.complete(config, systemPrompt, userPrompt, assistantContext);
      return { best: result, all: [result], consensusScore: 1.0 };
    }

    // Run multiple variations in parallel
    const promises = Array.from({ length: config.variations }, () =>
      this.complete(config, systemPrompt, userPrompt, assistantContext),
    );

    const results = await Promise.allSettled(promises);
    const successes = results
      .filter((r): r is PromiseFulfilledResult<LLMResponse> => r.status === 'fulfilled')
      .map(r => r.value);

    if (successes.length === 0) {
      throw new Error('All consensus variations failed');
    }

    // Simple consensus: pick the longest response (most detailed)
    // In production, you'd compare JSON structures for agreement
    const best = successes.reduce((a, b) =>
      a.content.length > b.content.length ? a : b,
    );

    const consensusScore = successes.length / config.variations;

    return { best, all: successes, consensusScore };
  }

  private calculateActualCost(
    config: PerplexityConfig,
    usage?: OpenAI.Completions.CompletionUsage,
  ): number {
    if (!usage) return config.estimatedCostPerCall;

    const COST_PER_1K: Record<SonarModel, { input: number; output: number }> = {
      [SonarModel.SONAR]: { input: 0.001, output: 0.001 },
      [SonarModel.SONAR_PRO]: { input: 0.003, output: 0.015 },
      [SonarModel.SONAR_REASONING]: { input: 0.001, output: 0.005 },
      [SonarModel.SONAR_REASONING_PRO]: { input: 0.002, output: 0.008 },
      [SonarModel.SONAR_DEEP_RESEARCH]: { input: 0.002, output: 0.008 },
    };

    const rates = COST_PER_1K[config.model];
    const inputCost = (usage.prompt_tokens / 1000) * rates.input;
    const outputCost = (usage.completion_tokens / 1000) * rates.output;
    return Math.round((inputCost + outputCost) * 100000) / 100000;
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function isReasoningModel(model: SonarModel): boolean {
  return model === SonarModel.SONAR_REASONING || model === SonarModel.SONAR_REASONING_PRO;
}

export class PerplexityError extends Error {
  constructor(
    message: string,
    public config: PerplexityConfig,
  ) {
    super(message);
    this.name = 'PerplexityError';
  }
}
