/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/providers/openrouter.ts
 * @purpose OpenRouter API client — unified gateway to GPT-4o, Claude, Gemini, etc.
 * @api https://openrouter.ai/api/v1/chat/completions
 */

import OpenAI from 'openai';
import {
  GeneralModel,
  GeneralModelConfig,
  LLMResponse,
  Provider,
  VisionConfig,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════
// MODEL ID MAPPING (OpenRouter model identifiers)
// ═══════════════════════════════════════════════════════════════

const OPENROUTER_MODEL_IDS: Record<GeneralModel, string> = {
  // Fast tier
  [GeneralModel.GPT4O_MINI]: 'openai/gpt-4o-mini',
  [GeneralModel.GEMINI_FLASH]: 'google/gemini-2.5-flash-preview',
  [GeneralModel.CLAUDE_HAIKU]: 'anthropic/claude-3-5-haiku',

  // Strategic tier
  [GeneralModel.GPT4O]: 'openai/gpt-4o',
  [GeneralModel.CLAUDE_SONNET]: 'anthropic/claude-sonnet-4-20250514',
  [GeneralModel.GEMINI_PRO]: 'google/gemini-2.5-pro-preview',

  // Critical tier
  [GeneralModel.CLAUDE_OPUS]: 'anthropic/claude-3-opus',
  [GeneralModel.O1]: 'openai/o1',
  [GeneralModel.O3]: 'openai/o3',

  // Vision (same models, vision-enabled)
  [GeneralModel.GPT4O_VISION]: 'openai/gpt-4o',
  [GeneralModel.CLAUDE_SONNET_VISION]: 'anthropic/claude-sonnet-4-20250514',
  [GeneralModel.GEMINI_FLASH_VISION]: 'google/gemini-2.5-flash-preview',
};

// ═══════════════════════════════════════════════════════════════
// CLIENT
// ═══════════════════════════════════════════════════════════════

export class OpenRouterClient {
  private client: OpenAI;
  private appName: string;

  constructor(apiKey: string, appName: string = 'L9-SEO-Bot') {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://l9.systems',
        'X-Title': appName,
      },
    });
    this.appName = appName;
  }

  /**
   * Execute a text completion using the resolved GeneralModelConfig.
   */
  async complete(
    config: GeneralModelConfig,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const modelId = OPENROUTER_MODEL_IDS[config.model];

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const requestBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: modelId,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    };

    // Add JSON response format if needed
    if (config.responseFormat === 'json') {
      requestBody.response_format = { type: 'json_object' };
    }

    try {
      const response = await this.client.chat.completions.create(requestBody);
      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      return {
        content: choice?.message?.content ?? '',
        model: config.model,
        provider: Provider.OPENROUTER,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        cost: this.calculateCost(config.model, response.usage),
        latencyMs,
        cached: false,
      };
    } catch (error) {
      throw new OpenRouterError(
        `OpenRouter API call failed [${modelId}]: ${error instanceof Error ? error.message : String(error)}`,
        config,
      );
    }
  }

  /**
   * Execute a vision completion with image(s).
   */
  async completeWithVision(
    config: VisionConfig,
    systemPrompt: string,
    userPrompt: string,
    imageUrls: string[],
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    const modelId = OPENROUTER_MODEL_IDS[config.model];

    // Build content array with text + images
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: userPrompt },
    ];

    for (const url of imageUrls) {
      if (url.startsWith('data:')) {
        // Base64 encoded image
        content.push({
          type: 'image_url',
          image_url: { url, detail: config.detail ?? 'auto' },
        });
      } else {
        // URL-based image
        content.push({
          type: 'image_url',
          image_url: { url, detail: config.detail ?? 'auto' },
        });
      }
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ];

    try {
      const response = await this.client.chat.completions.create({
        model: modelId,
        messages,
        temperature: 0.2,
        max_tokens: config.maxTokens,
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      return {
        content: choice?.message?.content ?? '',
        model: config.model,
        provider: Provider.OPENROUTER,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        cost: this.calculateCost(config.model, response.usage),
        latencyMs,
        cached: false,
      };
    } catch (error) {
      throw new OpenRouterError(
        `OpenRouter Vision call failed [${modelId}]: ${error instanceof Error ? error.message : String(error)}`,
        config as unknown as GeneralModelConfig,
      );
    }
  }

  /**
   * Execute with automatic fallback chain.
   */
  async completeWithFallback(
    config: GeneralModelConfig,
    fallbackModels: GeneralModel[],
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LLMResponse> {
    // Try primary model first
    try {
      return await this.complete(config, systemPrompt, userPrompt);
    } catch (primaryError) {
      // Try fallbacks in order
      for (const fallbackModel of fallbackModels) {
        try {
          const fallbackConfig: GeneralModelConfig = {
            ...config,
            model: fallbackModel,
            resolutionReason: `Fallback from ${config.model}: ${primaryError instanceof Error ? primaryError.message : 'unknown error'}`,
          };
          return await this.complete(fallbackConfig, systemPrompt, userPrompt);
        } catch {
          continue; // Try next fallback
        }
      }

      // All fallbacks failed
      throw new OpenRouterError(
        `All models failed (primary: ${config.model}, fallbacks: ${fallbackModels.join(', ')})`,
        config,
      );
    }
  }

  private calculateCost(
    model: GeneralModel,
    usage?: OpenAI.Completions.CompletionUsage,
  ): number {
    if (!usage) return 0;

    // Cost per 1M tokens (OpenRouter pricing)
    const COST_PER_1M: Record<GeneralModel, { input: number; output: number }> = {
      [GeneralModel.GPT4O_MINI]: { input: 0.15, output: 0.60 },
      [GeneralModel.GEMINI_FLASH]: { input: 0.15, output: 0.60 },
      [GeneralModel.CLAUDE_HAIKU]: { input: 0.80, output: 4.00 },
      [GeneralModel.GPT4O]: { input: 2.50, output: 10.00 },
      [GeneralModel.CLAUDE_SONNET]: { input: 3.00, output: 15.00 },
      [GeneralModel.GEMINI_PRO]: { input: 1.25, output: 10.00 },
      [GeneralModel.CLAUDE_OPUS]: { input: 15.00, output: 75.00 },
      [GeneralModel.O1]: { input: 15.00, output: 60.00 },
      [GeneralModel.O3]: { input: 15.00, output: 60.00 },
      [GeneralModel.GPT4O_VISION]: { input: 2.50, output: 10.00 },
      [GeneralModel.CLAUDE_SONNET_VISION]: { input: 3.00, output: 15.00 },
      [GeneralModel.GEMINI_FLASH_VISION]: { input: 0.15, output: 0.60 },
    };

    const rates = COST_PER_1M[model];
    const inputCost = (usage.prompt_tokens / 1_000_000) * rates.input;
    const outputCost = (usage.completion_tokens / 1_000_000) * rates.output;
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
  }
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public config: GeneralModelConfig,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}
