/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/matrices/general-matrix.ts
 * @purpose General-purpose model selection matrix for non-search tasks
 * @providers OpenRouter (primary), Anthropic Direct (fallback), OpenAI Direct (fallback)
 * @pattern Task complexity × Task type → Model + Provider
 */

import {
  GeneralModel,
  Provider,
  TaskType,
  TaskComplexity,
  TaskDescriptor,
  GeneralModelConfig,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════
// COST MODEL (per 1K output tokens, approximate)
// ═══════════════════════════════════════════════════════════════

const MODEL_COST_PER_1K_OUTPUT: Record<GeneralModel, number> = {
  // Fast tier
  [GeneralModel.GPT4O_MINI]: 0.0006,
  [GeneralModel.GEMINI_FLASH]: 0.0004,
  [GeneralModel.CLAUDE_HAIKU]: 0.001,

  // Strategic tier
  [GeneralModel.GPT4O]: 0.01,
  [GeneralModel.CLAUDE_SONNET]: 0.015,
  [GeneralModel.GEMINI_PRO]: 0.01,

  // Critical tier
  [GeneralModel.CLAUDE_OPUS]: 0.075,
  [GeneralModel.O1]: 0.06,
  [GeneralModel.O3]: 0.06,

  // Vision (same as base models)
  [GeneralModel.GPT4O_VISION]: 0.01,
  [GeneralModel.CLAUDE_SONNET_VISION]: 0.015,
  [GeneralModel.GEMINI_FLASH_VISION]: 0.0004,
};

// ═══════════════════════════════════════════════════════════════
// MODEL STRENGTHS (which model excels at what)
// ═══════════════════════════════════════════════════════════════

/**
 * Model selection is not just about cost — each model has strengths:
 * 
 * Claude Sonnet/Opus: Best long-form writing, nuanced reasoning, instruction following
 * GPT-4o: Best structured output (JSON), fastest tool/function calling, vision
 * Gemini Flash: Cheapest, massive context window, good for bulk analysis
 * GPT-4o-mini: Best cost/quality ratio for simple tasks
 * O1/O3: Best multi-step reasoning, math, code
 */

interface ModelSelection {
  model: GeneralModel;
  reason: string;
}

const TASK_MODEL_MAP: Record<TaskType, Partial<Record<TaskComplexity, ModelSelection>>> = {
  [TaskType.CLASSIFICATION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Binary classification — cheapest model sufficient' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Simple classification — fast tier' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O_MINI, reason: 'Multi-class classification — still fast tier' },
    [TaskComplexity.HIGH]: { model: GeneralModel.GPT4O, reason: 'Complex classification with nuance' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical classification requiring careful reasoning' },
  },

  [TaskType.EXTRACTION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Simple field extraction' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Structured extraction — JSON mode' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O, reason: 'Complex extraction — GPT-4o JSON mode best-in-class' },
    [TaskComplexity.HIGH]: { model: GeneralModel.GPT4O, reason: 'Multi-entity extraction with relationships' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical extraction requiring deep document understanding' },
  },

  [TaskType.SCORING]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Simple numeric scoring' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Multi-criteria scoring' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O_MINI, reason: 'Weighted scoring — still fast tier' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Complex scoring with qualitative reasoning' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Critical scoring — needs careful justification' },
  },

  [TaskType.CONTENT_GENERATION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Short content — meta tags, titles' },
    [TaskComplexity.LOW]: { model: GeneralModel.CLAUDE_HAIKU, reason: 'Short-form content — Haiku writes well cheaply' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Blog posts, outreach emails — Sonnet best writer' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Long-form authoritative content — Sonnet excels' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_OPUS, reason: 'Critical content requiring exceptional quality' },
  },

  [TaskType.STRATEGIC_REASONING]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Simple decision' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O, reason: 'Basic strategy' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Multi-factor strategy — Sonnet strong reasoning' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Complex strategy with trade-offs' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.O3, reason: 'Critical strategy — O3 best multi-step reasoning' },
  },

  [TaskType.CODE_GENERATION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Simple code snippet' },
    [TaskComplexity.LOW]: { model: GeneralModel.CLAUDE_HAIKU, reason: 'Short function — Haiku good at code' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Module-level code — Sonnet excellent coder' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Complex code with architecture decisions' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.O3, reason: 'Critical code — O3 best for complex logic' },
  },

  // Search tasks — shouldn't hit this matrix (Perplexity handles them)
  // But if they do (fallback), route to capable models
  [TaskType.COMPETITOR_RESEARCH]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: simple research summary' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O, reason: 'Fallback: research synthesis' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: detailed research' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: complex research' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_OPUS, reason: 'Fallback: critical research' },
  },
  [TaskType.CITATION_CHECK]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: citation check' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: citation check' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O, reason: 'Fallback: citation analysis' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: deep citation analysis' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: critical citation' },
  },
  [TaskType.FACT_VERIFICATION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: fact check' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: fact check' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O, reason: 'Fallback: fact verification' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: complex verification' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_OPUS, reason: 'Fallback: critical verification' },
  },
  [TaskType.MARKET_RESEARCH]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: market summary' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O, reason: 'Fallback: market analysis' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: market research' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: deep market research' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_OPUS, reason: 'Fallback: critical market research' },
  },
  [TaskType.LINK_PROSPECTING]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: link prospect scoring' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_MINI, reason: 'Fallback: link prospect analysis' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O, reason: 'Fallback: link strategy' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: complex link strategy' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET, reason: 'Fallback: critical link strategy' },
  },

  // Vision tasks — route to vision-capable models
  [TaskType.VISUAL_QA]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GEMINI_FLASH_VISION, reason: 'Simple visual check — cheapest vision model' },
    [TaskComplexity.LOW]: { model: GeneralModel.GEMINI_FLASH_VISION, reason: 'Basic visual QA' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O_VISION, reason: 'Detailed visual analysis' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Complex visual reasoning' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Critical visual assessment' },
  },
  [TaskType.SCREENSHOT_ANALYSIS]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GEMINI_FLASH_VISION, reason: 'Quick screenshot check' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_VISION, reason: 'Screenshot element identification' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O_VISION, reason: 'Detailed screenshot analysis' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Complex layout analysis' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Critical design review' },
  },
  [TaskType.LAYOUT_VALIDATION]: {
    [TaskComplexity.TRIVIAL]: { model: GeneralModel.GEMINI_FLASH_VISION, reason: 'Quick alignment check' },
    [TaskComplexity.LOW]: { model: GeneralModel.GPT4O_VISION, reason: 'Basic layout validation' },
    [TaskComplexity.MEDIUM]: { model: GeneralModel.GPT4O_VISION, reason: 'Multi-element layout check' },
    [TaskComplexity.HIGH]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Full page layout review' },
    [TaskComplexity.CRITICAL]: { model: GeneralModel.CLAUDE_SONNET_VISION, reason: 'Critical design system validation' },
  },
};

// ═══════════════════════════════════════════════════════════════
// FALLBACK CHAINS
// ═══════════════════════════════════════════════════════════════

/**
 * If the primary model fails (rate limit, timeout, error),
 * fall back through this chain. Each model has 2 fallbacks.
 */
const FALLBACK_CHAINS: Record<GeneralModel, GeneralModel[]> = {
  [GeneralModel.GPT4O_MINI]: [GeneralModel.GEMINI_FLASH, GeneralModel.CLAUDE_HAIKU],
  [GeneralModel.GEMINI_FLASH]: [GeneralModel.GPT4O_MINI, GeneralModel.CLAUDE_HAIKU],
  [GeneralModel.CLAUDE_HAIKU]: [GeneralModel.GPT4O_MINI, GeneralModel.GEMINI_FLASH],

  [GeneralModel.GPT4O]: [GeneralModel.CLAUDE_SONNET, GeneralModel.GEMINI_PRO],
  [GeneralModel.CLAUDE_SONNET]: [GeneralModel.GPT4O, GeneralModel.GEMINI_PRO],
  [GeneralModel.GEMINI_PRO]: [GeneralModel.CLAUDE_SONNET, GeneralModel.GPT4O],

  [GeneralModel.CLAUDE_OPUS]: [GeneralModel.O3, GeneralModel.CLAUDE_SONNET],
  [GeneralModel.O1]: [GeneralModel.O3, GeneralModel.CLAUDE_SONNET],
  [GeneralModel.O3]: [GeneralModel.O1, GeneralModel.CLAUDE_OPUS],

  [GeneralModel.GPT4O_VISION]: [GeneralModel.CLAUDE_SONNET_VISION, GeneralModel.GEMINI_FLASH_VISION],
  [GeneralModel.CLAUDE_SONNET_VISION]: [GeneralModel.GPT4O_VISION, GeneralModel.GEMINI_FLASH_VISION],
  [GeneralModel.GEMINI_FLASH_VISION]: [GeneralModel.GPT4O_VISION, GeneralModel.CLAUDE_SONNET_VISION],
};

// ═══════════════════════════════════════════════════════════════
// MAX TOKENS RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveMaxTokens(task: TaskDescriptor): number {
  if (task.expectedOutputTokens) return task.expectedOutputTokens;

  switch (task.type) {
    case TaskType.CLASSIFICATION:
    case TaskType.SCORING:
      return 256;
    case TaskType.EXTRACTION:
      return task.complexity >= TaskComplexity.HIGH ? 2048 : 1024;
    case TaskType.CONTENT_GENERATION:
      return task.complexity >= TaskComplexity.HIGH ? 4096 : 2048;
    case TaskType.STRATEGIC_REASONING:
      return task.complexity >= TaskComplexity.HIGH ? 4096 : 2048;
    case TaskType.CODE_GENERATION:
      return task.complexity >= TaskComplexity.HIGH ? 4096 : 2048;
    case TaskType.VISUAL_QA:
    case TaskType.SCREENSHOT_ANALYSIS:
    case TaskType.LAYOUT_VALIDATION:
      return 2048;
    default:
      return 2048;
  }
}

// ═══════════════════════════════════════════════════════════════
// TEMPERATURE RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveTemperature(task: TaskDescriptor): number {
  switch (task.type) {
    case TaskType.CLASSIFICATION:
    case TaskType.SCORING:
    case TaskType.EXTRACTION:
      return 0.1; // Deterministic
    case TaskType.CONTENT_GENERATION:
      return 0.7; // Creative
    case TaskType.STRATEGIC_REASONING:
      return 0.3; // Balanced
    case TaskType.CODE_GENERATION:
      return 0.2; // Precise
    case TaskType.VISUAL_QA:
    case TaskType.SCREENSHOT_ANALYSIS:
    case TaskType.LAYOUT_VALIDATION:
      return 0.2; // Precise observations
    default:
      return 0.3;
  }
}

// ═══════════════════════════════════════════════════════════════
// COST ESTIMATOR
// ═══════════════════════════════════════════════════════════════

export function estimateGeneralCost(model: GeneralModel, maxTokens: number): number {
  const costPer1K = MODEL_COST_PER_1K_OUTPUT[model];
  // Assume input tokens ≈ 2x output tokens for cost estimation
  const totalTokens = maxTokens * 2.5;
  return Math.round((totalTokens / 1000) * costPer1K * 100000) / 100000;
}

// ═══════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════

/**
 * Resolves a TaskDescriptor into a GeneralModelConfig.
 * Deterministic — no LLM call needed for routing.
 */
export function resolveGeneralConfig(task: TaskDescriptor): GeneralModelConfig {
  const selection = TASK_MODEL_MAP[task.type]?.[task.complexity];

  if (!selection) {
    // Fallback: GPT-4o-mini for unknown combinations
    return {
      model: GeneralModel.GPT4O_MINI,
      provider: Provider.OPENROUTER,
      temperature: 0.3,
      maxTokens: 2048,
      responseFormat: 'text',
      estimatedCostPerCall: estimateGeneralCost(GeneralModel.GPT4O_MINI, 2048),
      resolutionReason: `Fallback: No mapping for Task[${task.type}] × Complexity[${task.complexity}]`,
    };
  }

  const maxTokens = resolveMaxTokens(task);
  const temperature = resolveTemperature(task);

  // Determine response format
  let responseFormat: 'json' | 'text' = 'text';
  if (
    task.type === TaskType.CLASSIFICATION ||
    task.type === TaskType.EXTRACTION ||
    task.type === TaskType.SCORING
  ) {
    responseFormat = 'json';
  }

  return {
    model: selection.model,
    provider: Provider.OPENROUTER, // All general models route through OpenRouter
    temperature,
    maxTokens,
    responseFormat,
    estimatedCostPerCall: estimateGeneralCost(selection.model, maxTokens),
    resolutionReason: selection.reason,
  };
}

/**
 * Get fallback models for a given primary model.
 */
export function getFallbackChain(model: GeneralModel): GeneralModel[] {
  return FALLBACK_CHAINS[model] ?? [GeneralModel.GPT4O_MINI];
}
