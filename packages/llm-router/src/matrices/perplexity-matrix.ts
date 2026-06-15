/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/matrices/perplexity-matrix.ts
 * @purpose Perplexity Sonar model + search depth resolver
 * @origin Ported from Enrichment.Inference.Engine/app/engines/search_optimizer.py
 * @pattern Deterministic resolution — no LLM call needed for routing
 */

import {
  SonarModel,
  SearchContextSize,
  SearchMode,
  RecencyFilter,
  MessageStrategy,
  TaskType,
  TaskComplexity,
  TaskDescriptor,
  PerplexityConfig,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════
// COST MODEL (aligned with Enrichment.Inference.Engine)
// ═══════════════════════════════════════════════════════════════

const MODEL_COST_PER_1K: Record<SonarModel, number> = {
  [SonarModel.SONAR]: 0.0005,
  [SonarModel.SONAR_PRO]: 0.003,
  [SonarModel.SONAR_REASONING]: 0.001,
  [SonarModel.SONAR_REASONING_PRO]: 0.005,
  [SonarModel.SONAR_DEEP_RESEARCH]: 0.008,
};

const CONTEXT_COST_MULTIPLIER: Record<SearchContextSize, number> = {
  [SearchContextSize.LOW]: 0.6,
  [SearchContextSize.MEDIUM]: 1.0,
  [SearchContextSize.HIGH]: 1.8,
};

// ═══════════════════════════════════════════════════════════════
// TASK-TO-MODEL MAPPING
// ═══════════════════════════════════════════════════════════════

/**
 * Maps task type + complexity to the appropriate Sonar model.
 * 
 * Principle: Start cheap, escalate only when the task demands it.
 * The resolver never picks DEEP_RESEARCH unless the task is explicitly
 * marked as CRITICAL complexity with search requirement.
 */
const TASK_MODEL_MAP: Record<TaskType, Partial<Record<TaskComplexity, SonarModel>>> = {
  // Search-grounded tasks (Perplexity's strength)
  [TaskType.COMPETITOR_RESEARCH]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR_PRO,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING_PRO,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_DEEP_RESEARCH,
  },
  [TaskType.CITATION_CHECK]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING_PRO,
  },
  [TaskType.FACT_VERIFICATION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING_PRO,
  },
  [TaskType.MARKET_RESEARCH]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR_PRO,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING_PRO,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_DEEP_RESEARCH,
  },
  [TaskType.LINK_PROSPECTING]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_PRO,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING,
  },
  // Non-search tasks — Perplexity shouldn't handle these, but if forced:
  [TaskType.CLASSIFICATION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING,
  },
  [TaskType.EXTRACTION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_PRO,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING,
  },
  [TaskType.SCORING]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING,
  },
  [TaskType.CONTENT_GENERATION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR_PRO,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING_PRO,
  },
  [TaskType.STRATEGIC_REASONING]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR_REASONING,
    [TaskComplexity.LOW]: SonarModel.SONAR_REASONING,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_REASONING_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING_PRO,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_DEEP_RESEARCH,
  },
  [TaskType.CODE_GENERATION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR_PRO,
    [TaskComplexity.HIGH]: SonarModel.SONAR_REASONING,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR_REASONING_PRO,
  },
  // Vision tasks — Perplexity doesn't handle these
  [TaskType.VISUAL_QA]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR,
    [TaskComplexity.HIGH]: SonarModel.SONAR,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR,
  },
  [TaskType.SCREENSHOT_ANALYSIS]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR,
    [TaskComplexity.HIGH]: SonarModel.SONAR,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR,
  },
  [TaskType.LAYOUT_VALIDATION]: {
    [TaskComplexity.TRIVIAL]: SonarModel.SONAR,
    [TaskComplexity.LOW]: SonarModel.SONAR,
    [TaskComplexity.MEDIUM]: SonarModel.SONAR,
    [TaskComplexity.HIGH]: SonarModel.SONAR,
    [TaskComplexity.CRITICAL]: SonarModel.SONAR,
  },
};

// ═══════════════════════════════════════════════════════════════
// CONTEXT SIZE RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveContextSize(task: TaskDescriptor): SearchContextSize {
  // Deep research always gets HIGH context
  if (task.complexity === TaskComplexity.CRITICAL) return SearchContextSize.HIGH;

  // Competitor research and market research benefit from more context
  if (
    task.type === TaskType.COMPETITOR_RESEARCH ||
    task.type === TaskType.MARKET_RESEARCH
  ) {
    return task.complexity >= TaskComplexity.MEDIUM
      ? SearchContextSize.HIGH
      : SearchContextSize.MEDIUM;
  }

  // Citation checks need focused, not broad
  if (task.type === TaskType.CITATION_CHECK) return SearchContextSize.LOW;

  // Link prospecting benefits from breadth
  if (task.type === TaskType.LINK_PROSPECTING) return SearchContextSize.HIGH;

  // Default: match complexity
  if (task.complexity <= TaskComplexity.LOW) return SearchContextSize.LOW;
  if (task.complexity === TaskComplexity.MEDIUM) return SearchContextSize.MEDIUM;
  return SearchContextSize.HIGH;
}

// ═══════════════════════════════════════════════════════════════
// RECENCY RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveRecency(task: TaskDescriptor): RecencyFilter {
  // If explicitly specified, use it
  if (task.recency) return task.recency;

  // Competitor research should be recent
  if (task.type === TaskType.COMPETITOR_RESEARCH) return RecencyFilter.WEEK;

  // Citation checks — recent to see current AI responses
  if (task.type === TaskType.CITATION_CHECK) return RecencyFilter.MONTH;

  // Market research — recent but not too narrow
  if (task.type === TaskType.MARKET_RESEARCH) return RecencyFilter.MONTH;

  // Link prospecting — no filter (evergreen content is fine)
  if (task.type === TaskType.LINK_PROSPECTING) return RecencyFilter.NONE;

  // Fact verification — no filter
  if (task.type === TaskType.FACT_VERIFICATION) return RecencyFilter.NONE;

  return RecencyFilter.NONE;
}

// ═══════════════════════════════════════════════════════════════
// MAX TOKENS RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveMaxTokens(task: TaskDescriptor): number {
  if (task.expectedOutputTokens) return task.expectedOutputTokens;

  // Deep research gets generous allocation
  if (task.complexity === TaskComplexity.CRITICAL) return 4096;

  // Strategic reasoning needs room to think
  if (task.type === TaskType.STRATEGIC_REASONING) return 3072;

  // Content generation varies
  if (task.type === TaskType.CONTENT_GENERATION) {
    return task.complexity >= TaskComplexity.HIGH ? 3072 : 2048;
  }

  // Classification/scoring are short
  if (
    task.type === TaskType.CLASSIFICATION ||
    task.type === TaskType.SCORING
  ) {
    return 512;
  }

  // Default
  return 2048;
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE STRATEGY RESOLVER
// ═══════════════════════════════════════════════════════════════

function resolveMessageStrategy(task: TaskDescriptor): MessageStrategy {
  // Reasoning tasks benefit from assistant context injection
  if (task.requiresReasoning) return MessageStrategy.SYSTEM_USER_ASSISTANT;
  if (task.type === TaskType.STRATEGIC_REASONING) return MessageStrategy.SYSTEM_USER_ASSISTANT;
  if (task.complexity >= TaskComplexity.HIGH) return MessageStrategy.SYSTEM_USER_ASSISTANT;

  return MessageStrategy.SYSTEM_USER;
}

// ═══════════════════════════════════════════════════════════════
// COST ESTIMATOR
// ═══════════════════════════════════════════════════════════════

export function estimatePerplexityCost(config: PerplexityConfig): number {
  const base = MODEL_COST_PER_1K[config.model];
  const ctxMult = CONTEXT_COST_MULTIPLIER[config.searchContextSize];
  const tokensPerVar = config.maxTokens * 1.5; // Account for input + output
  const costPerVar = (tokensPerVar / 1000) * base * ctxMult;
  return Math.round(costPerVar * config.variations * 100000) / 100000;
}

// ═══════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════

/**
 * Resolves a TaskDescriptor into a complete PerplexityConfig.
 * 
 * This is a deterministic function — no LLM call needed.
 * The routing decision is pure code based on task classification.
 */
export function resolvePerplexityConfig(task: TaskDescriptor): PerplexityConfig {
  const model = TASK_MODEL_MAP[task.type]?.[task.complexity] ?? SonarModel.SONAR;
  const searchContextSize = resolveContextSize(task);
  const recencyFilter = resolveRecency(task);
  const maxTokens = resolveMaxTokens(task);
  const messageStrategy = resolveMessageStrategy(task);

  // Determine search mode
  let searchMode = SearchMode.WEB;
  if (task.type === TaskType.FACT_VERIFICATION) searchMode = SearchMode.WEB;
  // Future: academic mode for research-heavy tasks

  // Determine variations (consensus mode from Enrichment Engine)
  let variations = 1;
  if (task.complexity >= TaskComplexity.HIGH) variations = 3;
  if (task.complexity === TaskComplexity.CRITICAL) variations = 5;

  // Reasoning effort for reasoning models
  let reasoningEffort: string | undefined;
  if (model === SonarModel.SONAR_REASONING || model === SonarModel.SONAR_REASONING_PRO) {
    reasoningEffort = task.complexity === TaskComplexity.CRITICAL ? 'high' : 'medium';
  }

  // Temperature: lower for extraction/classification, higher for generation
  let temperature = 0.3;
  if (task.type === TaskType.CONTENT_GENERATION) temperature = 0.7;
  if (task.type === TaskType.CLASSIFICATION || task.type === TaskType.SCORING) temperature = 0.1;

  const config: PerplexityConfig = {
    model,
    searchContextSize,
    searchMode,
    recencyFilter,
    messageStrategy,
    temperature,
    maxTokens,
    domainFilter: task.domainFilter ?? [],
    variations,
    reasoningEffort,
    disableSearch: !task.requiresSearch && !isSearchTask(task.type),
    estimatedCostPerCall: 0,
    resolutionReason: buildResolutionReason(task, model),
  };

  config.estimatedCostPerCall = estimatePerplexityCost(config);

  return config;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function isSearchTask(type: TaskType): boolean {
  return [
    TaskType.COMPETITOR_RESEARCH,
    TaskType.CITATION_CHECK,
    TaskType.FACT_VERIFICATION,
    TaskType.MARKET_RESEARCH,
    TaskType.LINK_PROSPECTING,
  ].includes(type);
}

function buildResolutionReason(task: TaskDescriptor, model: SonarModel): string {
  return `Task[${task.type}] × Complexity[${task.complexity}] → Model[${model}] | ${task.description ?? 'no description'}`;
}
