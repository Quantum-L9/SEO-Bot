# @l9/llm-router

> The shared intelligence routing layer for all L9 bots. One module, all models, zero waste.

## What This Is

A standalone, reusable TypeScript module that any L9 bot imports to get optimal model selection, budget enforcement, and multi-provider routing — without each bot implementing its own LLM integration.

```typescript
import { L9LLMRouter, TaskType, TaskComplexity } from '@l9/llm-router';

const router = new L9LLMRouter({
  perplexityApiKey: process.env.PERPLEXITY_API_KEY!,
  openrouterApiKey: process.env.OPENROUTER_API_KEY!,
  appName: 'L9-SEO-Bot',
});

router.initClient('safehavenrr', { monthlyBudgetPerClient: 200 });

const response = await router.execute(
  {
    clientId: 'safehavenrr',
    type: TaskType.CONTENT_GENERATION,
    complexity: TaskComplexity.MEDIUM,
    description: 'Write blog post about roof repair costs in Houston',
  },
  'You are an expert roofing content writer...',
  'Write a 1200-word blog post about...',
);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    L9LLMRouter.execute()                     │
├─────────────────────────────────────────────────────────────┤
│  1. Classify task → TaskType × TaskComplexity               │
│  2. Check budget → BudgetTracker.evaluateTask()             │
│  3. Route to matrix:                                        │
│     ├── Search tasks → Perplexity Matrix → Sonar models     │
│     ├── Vision tasks → Vision Matrix → GPT-4o/Claude/Gemini │
│     └── General tasks → General Matrix → Best model per job │
│  4. Execute via provider client                             │
│  5. Record spend + log routing decision                     │
└─────────────────────────────────────────────────────────────┘
```

## Three Matrices

### 1. Perplexity Matrix (Search-Grounded Tasks)

Ported from the [Enrichment.Inference.Engine](https://github.com/cryptoxdog/Enrichment.Inference.Engine) search optimizer. Maps task complexity to Sonar model + search depth:

| Complexity | Model | Search Context | Cost/Call |
|---|---|---|---|
| Trivial/Low | `sonar` | `low` | ~$0.001 |
| Medium | `sonar-pro` | `medium` | ~$0.01 |
| High | `sonar-pro` | `high` | ~$0.03 |
| Critical | `sonar-deep-research` | `high` | ~$0.05 |

Includes consensus mode (multiple variations for high-stakes research).

### 2. General Matrix (All Other Tasks)

Maps `TaskType × TaskComplexity` to the optimal model across providers:

| Task Type | Low | Medium | High | Critical |
|---|---|---|---|---|
| Classification | GPT-4o-mini | GPT-4o-mini | GPT-4o | Claude Sonnet |
| Content Generation | Claude Haiku | Claude Sonnet | Claude Sonnet | Claude Opus |
| Strategic Reasoning | GPT-4o | Claude Sonnet | Claude Sonnet | O3 |
| Code Generation | Claude Haiku | Claude Sonnet | Claude Sonnet | O3 |
| Extraction | GPT-4o-mini | GPT-4o | GPT-4o | Claude Sonnet |

Each model has a 2-deep fallback chain for resilience.

### 3. Vision Matrix (Visual QA Tasks)

| Complexity | Model | Detail | Cost/Call |
|---|---|---|---|
| Low (quick check) | Gemini Flash Vision | `low` | ~$0.001 |
| Medium (layout) | GPT-4o Vision | `auto` | ~$0.015 |
| High (detailed) | GPT-4o Vision | `high` | ~$0.02 |
| Multi-image comparison | Claude Sonnet Vision | `high` | ~$0.03 |

## Budget Engine

No daily hard cap. Trajectory-based throttling with surge awareness:

- **Monthly budget**: $200/client (configurable per-client)
- **Weekly target**: $50/week soft target
- **Weekly ceiling**: $100/week hard safety net
- **Surge**: If week-to-date spend < 60% by Thursday, allow burst up to ceiling
- **Critical override**: CRITICAL tasks ALWAYS proceed regardless of budget
- **Downgrade, don't kill**: Under throttle, tasks get cheaper models instead of being blocked

## Vision QA (Site Visual Validation)

The router includes a full Visual QA system that lets bots "see" websites:

```typescript
// Generate QA plan for a site
const tasks = router.planVisualQA({
  pages: ['https://safehavenrr.com', 'https://safehavenrr.com/services'],
  viewports: [VIEWPORTS.desktop_1440, VIEWPORTS.mobile_iphone],
  competitorUrl: 'https://competitor.com',
  conversionAudit: true,
});

// Bot takes screenshots, then executes each task
for (const task of tasks) {
  const result = await router.execute(
    { clientId: 'safehavenrr', type: TaskType.LAYOUT_VALIDATION, complexity: TaskComplexity.MEDIUM },
    task.prompt,
    'Analyze this screenshot',
    { images: [screenshotUrl] },
  );
}
```

Cost: ~$0.40 per full site audit (5 pages × 3 viewports + competitor + conversion).

## Consuming This Module

### From L9 SEO Bot

```typescript
// In l9-seo-bot/package.json
"dependencies": {
  "@l9/llm-router": "file:../l9-llm-router"
}
```

### From L9 Website Factory

```typescript
// In l9-website-factory/package.json
"dependencies": {
  "@l9/llm-router": "file:../l9-llm-router"
}
```

### From Any Future Bot

Same pattern. Import, configure with API keys, call `execute()`.

## Environment Variables

```env
OPENROUTER_API_KEY=sk-or-v1-...
PERPLEXITY_API_KEY=pplx-...
```

That's it. Two API keys give you access to every model.

## File Structure

```
src/
├── index.ts                    # Main router + re-exports
├── types.ts                    # All types, enums, interfaces
├── matrices/
│   ├── perplexity-matrix.ts    # Search task → Sonar model resolver
│   └── general-matrix.ts       # General task → model resolver
├── vision/
│   └── index.ts                # Visual QA engine + prompts
├── budget/
│   └── index.ts                # Budget tracker + throttle engine
└── providers/
    ├── perplexity.ts           # Perplexity API client
    └── openrouter.ts           # OpenRouter API client
```

## Design Principles

1. **Deterministic routing** — No LLM call needed to decide which LLM to call
2. **Budget-aware, not budget-killed** — Downgrade models under pressure, never block critical work
3. **Provider-agnostic** — Bots don't know or care which provider serves the response
4. **Surge-friendly** — Quiet weeks allow burst activity without throttling
5. **Consensus-capable** — High-stakes research runs multiple variations for reliability
6. **Vision-native** — Visual QA is a first-class capability, not an afterthought
7. **Portable** — Any L9 bot imports this module identically
