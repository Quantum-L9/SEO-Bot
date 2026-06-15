/**
 * @l9_meta
 * @module @l9/llm-router
 * @file src/vision/index.ts
 * @purpose Visual QA engine — uses vision models to "see" sites like a human would
 * @use_case Layout validation, alignment checks, mobile/desktop rendering QA
 * @answer_to "Can/should we use GPT's built-in vision to see the site?"
 * 
 * YES. The Vision QA module captures screenshots at desktop and mobile viewports,
 * then uses vision-capable LLMs to detect:
 * - Misaligned elements
 * - Overlapping text
 * - Broken layouts
 * - Missing images (broken img tags)
 * - Color contrast issues visible to the eye
 * - CTA visibility and prominence
 * - Overall professional appearance
 * 
 * This is NOT a replacement for automated testing (Lighthouse, axe-core).
 * It's the "human eye" check that catches things automated tools miss.
 */

import {
  GeneralModel,
  Provider,
  TaskComplexity,
  TaskType,
  VisionConfig,
  LLMResponse,
} from '../types.js';

// ═══════════════════════════════════════════════════════════════
// VIEWPORT DEFINITIONS
// ═══════════════════════════════════════════════════════════════

export interface ViewportConfig {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  userAgent?: string;
}

export const VIEWPORTS: Record<string, ViewportConfig> = {
  desktop_1920: {
    name: 'Desktop 1920×1080',
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
  },
  desktop_1440: {
    name: 'Desktop 1440×900',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
  },
  tablet_ipad: {
    name: 'iPad 768×1024',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  },
  mobile_iphone: {
    name: 'iPhone 14 Pro 393×852',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  },
  mobile_android: {
    name: 'Pixel 7 412×915',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36',
  },
};

// ═══════════════════════════════════════════════════════════════
// VISUAL QA PROMPTS
// ═══════════════════════════════════════════════════════════════

export const VISUAL_QA_PROMPTS = {
  layout_validation: `You are a senior web designer reviewing a website screenshot for quality issues.

Analyze this screenshot and report ANY of the following problems:

1. ALIGNMENT: Are elements properly aligned? Look for off-center text, uneven margins, misaligned columns.
2. OVERLAP: Is any text overlapping other text or images? Are elements bleeding into each other?
3. SPACING: Is spacing consistent? Look for cramped areas or excessive whitespace.
4. READABILITY: Can all text be easily read? Check for low contrast, too-small fonts, text over busy backgrounds.
5. IMAGES: Are there broken images (empty boxes, alt text showing)? Are images properly sized?
6. CTA VISIBILITY: Is the primary call-to-action clearly visible and prominent?
7. NAVIGATION: Is the navigation clear and accessible?
8. MOBILE RESPONSIVENESS: (if mobile viewport) Does the layout adapt properly? No horizontal scroll needed?
9. PROFESSIONAL APPEARANCE: Does this look like a professional, trustworthy business website?
10. BRAND CONSISTENCY: Are colors, fonts, and styling consistent across visible elements?

For each issue found, report:
- SEVERITY: critical | major | minor | cosmetic
- LOCATION: Where on the page (top/middle/bottom, left/center/right)
- DESCRIPTION: What exactly is wrong
- SUGGESTION: How to fix it

If the page looks good, say so explicitly. Do not invent problems that don't exist.

Respond in JSON format:
{
  "overall_score": 1-10,
  "viewport": "desktop|mobile|tablet",
  "issues": [...],
  "strengths": [...],
  "professional_impression": "string"
}`,

  competitor_comparison: `You are comparing two website screenshots side by side.

Image 1 is OUR client's website.
Image 2 is the TOP COMPETITOR's website.

Compare them on:
1. Visual professionalism
2. CTA clarity and prominence
3. Trust signals (testimonials, badges, certifications visible)
4. Content density and readability
5. Mobile-friendliness (if mobile viewport)
6. Overall first impression

For each dimension, declare a winner and explain why.
Then provide 3 specific, actionable recommendations for our client's site to surpass the competitor visually.

Respond in JSON format:
{
  "dimensions": [...],
  "overall_winner": "ours|competitor",
  "gap_severity": "none|minor|significant|critical",
  "recommendations": [...]
}`,

  conversion_audit: `You are a conversion rate optimization (CRO) expert reviewing a website screenshot.

Analyze this page from a conversion perspective:
1. Is the value proposition immediately clear within 3 seconds?
2. Is there a clear, visible CTA above the fold?
3. Are trust signals present (reviews, badges, guarantees)?
4. Is the form (if present) short and non-intimidating?
5. Is there social proof visible?
6. Does the page create urgency or scarcity?
7. Is the navigation simple or overwhelming?
8. Are there distracting elements pulling attention from the CTA?

Respond in JSON format:
{
  "conversion_score": 1-10,
  "above_fold_cta_visible": boolean,
  "value_prop_clear": boolean,
  "trust_signals_count": number,
  "issues": [...],
  "quick_wins": [...]
}`,
};

// ═══════════════════════════════════════════════════════════════
// VISION CONFIG RESOLVER
// ═══════════════════════════════════════════════════════════════

export function resolveVisionConfig(
  taskType: TaskType.VISUAL_QA | TaskType.SCREENSHOT_ANALYSIS | TaskType.LAYOUT_VALIDATION,
  complexity: TaskComplexity,
  imageCount: number = 1,
): VisionConfig {
  // For single-image quick checks, use the cheapest vision model
  if (complexity <= TaskComplexity.LOW && imageCount <= 1) {
    return {
      model: GeneralModel.GEMINI_FLASH_VISION,
      provider: Provider.OPENROUTER,
      maxTokens: 1024,
      detail: 'low',
      estimatedCostPerCall: 0.001,
      resolutionReason: 'Quick visual check — Gemini Flash cheapest vision model',
    };
  }

  // For detailed layout validation, use GPT-4o (best at structured visual analysis)
  if (taskType === TaskType.LAYOUT_VALIDATION || complexity >= TaskComplexity.HIGH) {
    return {
      model: GeneralModel.GPT4O_VISION,
      provider: Provider.OPENROUTER,
      maxTokens: 2048,
      detail: 'high',
      estimatedCostPerCall: 0.02,
      resolutionReason: 'Detailed layout validation — GPT-4o best structured visual analysis',
    };
  }

  // For competitor comparison (multiple images), use Claude (best at nuanced comparison)
  if (imageCount > 1) {
    return {
      model: GeneralModel.CLAUDE_SONNET_VISION,
      provider: Provider.OPENROUTER,
      maxTokens: 2048,
      detail: 'high',
      estimatedCostPerCall: 0.03,
      resolutionReason: 'Multi-image comparison — Claude best at nuanced visual reasoning',
    };
  }

  // Default: GPT-4o for general screenshot analysis
  return {
    model: GeneralModel.GPT4O_VISION,
    provider: Provider.OPENROUTER,
    maxTokens: 1536,
    detail: 'auto',
    estimatedCostPerCall: 0.015,
    resolutionReason: 'Standard screenshot analysis — GPT-4o reliable default',
  };
}

// ═══════════════════════════════════════════════════════════════
// VISUAL QA TASK BUILDERS
// ═══════════════════════════════════════════════════════════════

export interface VisualQATask {
  prompt: string;
  images: string[]; // URLs or base64
  viewport: ViewportConfig;
  config: VisionConfig;
}

/**
 * Build a layout validation task for a specific page and viewport.
 * The calling bot is responsible for taking the screenshot.
 */
export function buildLayoutValidationTask(
  screenshotUrl: string,
  viewport: ViewportConfig,
  complexity: TaskComplexity = TaskComplexity.MEDIUM,
): VisualQATask {
  return {
    prompt: VISUAL_QA_PROMPTS.layout_validation,
    images: [screenshotUrl],
    viewport,
    config: resolveVisionConfig(TaskType.LAYOUT_VALIDATION, complexity, 1),
  };
}

/**
 * Build a competitor comparison task with two screenshots.
 */
export function buildCompetitorComparisonTask(
  ourScreenshotUrl: string,
  competitorScreenshotUrl: string,
  viewport: ViewportConfig,
): VisualQATask {
  return {
    prompt: VISUAL_QA_PROMPTS.competitor_comparison,
    images: [ourScreenshotUrl, competitorScreenshotUrl],
    viewport,
    config: resolveVisionConfig(TaskType.SCREENSHOT_ANALYSIS, TaskComplexity.HIGH, 2),
  };
}

/**
 * Build a conversion audit task for a landing page.
 */
export function buildConversionAuditTask(
  screenshotUrl: string,
  viewport: ViewportConfig,
): VisualQATask {
  return {
    prompt: VISUAL_QA_PROMPTS.conversion_audit,
    images: [screenshotUrl],
    viewport,
    config: resolveVisionConfig(TaskType.VISUAL_QA, TaskComplexity.MEDIUM, 1),
  };
}

// ═══════════════════════════════════════════════════════════════
// FULL-SITE QA ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

export interface FullSiteQAConfig {
  /** URLs to check */
  pages: string[];
  /** Which viewports to test */
  viewports: ViewportConfig[];
  /** Whether to do competitor comparison */
  competitorUrl?: string;
  /** Whether to do conversion audit on landing pages */
  conversionAudit: boolean;
}

/**
 * Generates the complete set of visual QA tasks for a full site audit.
 * The calling bot executes these tasks and aggregates results.
 * 
 * Cost estimate for a 5-page site, 3 viewports:
 * - Layout validation: 5 pages × 3 viewports × $0.015 = $0.225
 * - Competitor comparison: 5 pages × 1 viewport × $0.03 = $0.15
 * - Conversion audit: 2 landing pages × $0.015 = $0.03
 * - Total: ~$0.40 per full site audit
 * 
 * Run weekly = ~$1.60/month per client for visual QA
 */
export function generateFullSiteQAPlan(config: FullSiteQAConfig): VisualQATask[] {
  const tasks: VisualQATask[] = [];

  // Layout validation for every page × viewport combination
  for (const page of config.pages) {
    for (const viewport of config.viewports) {
      tasks.push(buildLayoutValidationTask(page, viewport));
    }
  }

  // Competitor comparison (desktop only, homepage + key pages)
  if (config.competitorUrl) {
    const desktopViewport = VIEWPORTS.desktop_1440;
    for (const page of config.pages.slice(0, 3)) { // Top 3 pages only
      tasks.push(buildCompetitorComparisonTask(page, config.competitorUrl, desktopViewport));
    }
  }

  // Conversion audit on landing pages
  if (config.conversionAudit) {
    const mobileViewport = VIEWPORTS.mobile_iphone;
    // First 2 pages assumed to be landing pages
    for (const page of config.pages.slice(0, 2)) {
      tasks.push(buildConversionAuditTask(page, mobileViewport));
    }
  }

  return tasks;
}
