/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Behavior Intelligence Recommendations Engine
 * 
 * Transforms raw PostHog engagement data into actionable multiple-choice
 * recommendations with AI-generated rationale. Low-risk options are
 * auto-executed; high-risk options are queued for operator approval.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../../core/database/index.js';
import { getLlmService } from '../../services/llm.js';
import { evaluateExecution, logAction } from '../../core/execution-policy.js';
import { createModuleLogger } from '../../core/logger.js';
import type { ActionOption, ActionProposal } from '../../core/execution-policy.js';

const logger = createModuleLogger('behavior-recommendations');

// ─── Threshold Definitions ────────────────────────────────────────────────────

interface ThresholdConfig {
  bounceRate: { warning: number; critical: number };
  avgTimeOnPage: { warning: number; critical: number }; // seconds
  scrollDepth: { warning: number; critical: number }; // percentage
  exitRate: { warning: number; critical: number };
}

const THRESHOLDS: ThresholdConfig = {
  bounceRate: { warning: 0.60, critical: 0.80 },
  avgTimeOnPage: { warning: 30, critical: 15 }, // below these = bad
  scrollDepth: { warning: 0.40, critical: 0.20 }, // below these = bad
  exitRate: { warning: 0.50, critical: 0.70 },
};

// Industry benchmarks for local service businesses
const BENCHMARKS = {
  bounceRate: 0.45,
  avgTimeOnPage: 120, // 2 minutes
  scrollDepth: 0.65,
  exitRate: 0.35,
};

// ─── Issue Detection ──────────────────────────────────────────────────────────

interface DetectedIssue {
  pagePath: string;
  metric: string;
  currentValue: number;
  benchmarkValue: number;
  severity: 'warning' | 'critical';
  description: string;
}

export async function detectBehaviorIssues(clientId: string): Promise<DetectedIssue[]> {
  const db = getDb();
  const issues: DetectedIssue[] = [];

  // Get latest engagement data
  const engagement = await db.select()
    .from(schema.pageEngagement)
    .where(eq(schema.pageEngagement.clientId, clientId))
    .orderBy(desc(schema.pageEngagement.computedAt))
    .limit(50);

  // Deduplicate by page (take most recent)
  const latestByPage = new Map<string, typeof engagement[0]>();
  for (const row of engagement) {
    if (!latestByPage.has(row.pagePath)) {
      latestByPage.set(row.pagePath, row);
    }
  }

  for (const [pagePath, data] of latestByPage) {
    // Bounce rate check
    if (data.bounceRate !== null && data.bounceRate > THRESHOLDS.bounceRate.critical) {
      issues.push({
        pagePath,
        metric: 'bounce_rate',
        currentValue: data.bounceRate,
        benchmarkValue: BENCHMARKS.bounceRate,
        severity: 'critical',
        description: `Bounce rate is ${(data.bounceRate * 100).toFixed(0)}% (benchmark: ${(BENCHMARKS.bounceRate * 100).toFixed(0)}%)`,
      });
    } else if (data.bounceRate !== null && data.bounceRate > THRESHOLDS.bounceRate.warning) {
      issues.push({
        pagePath,
        metric: 'bounce_rate',
        currentValue: data.bounceRate,
        benchmarkValue: BENCHMARKS.bounceRate,
        severity: 'warning',
        description: `Bounce rate is ${(data.bounceRate * 100).toFixed(0)}% (benchmark: ${(BENCHMARKS.bounceRate * 100).toFixed(0)}%)`,
      });
    }

    // Time on page check (low = bad)
    if (data.avgTimeOnPage !== null && data.avgTimeOnPage < THRESHOLDS.avgTimeOnPage.critical) {
      issues.push({
        pagePath,
        metric: 'time_on_page',
        currentValue: data.avgTimeOnPage,
        benchmarkValue: BENCHMARKS.avgTimeOnPage,
        severity: 'critical',
        description: `Avg time on page is ${data.avgTimeOnPage.toFixed(0)}s (benchmark: ${BENCHMARKS.avgTimeOnPage}s)`,
      });
    } else if (data.avgTimeOnPage !== null && data.avgTimeOnPage < THRESHOLDS.avgTimeOnPage.warning) {
      issues.push({
        pagePath,
        metric: 'time_on_page',
        currentValue: data.avgTimeOnPage,
        benchmarkValue: BENCHMARKS.avgTimeOnPage,
        severity: 'warning',
        description: `Avg time on page is ${data.avgTimeOnPage.toFixed(0)}s (benchmark: ${BENCHMARKS.avgTimeOnPage}s)`,
      });
    }

    // Scroll depth check (low = bad)
    if (data.avgScrollDepth !== null && data.avgScrollDepth < THRESHOLDS.scrollDepth.critical) {
      issues.push({
        pagePath,
        metric: 'scroll_depth',
        currentValue: data.avgScrollDepth,
        benchmarkValue: BENCHMARKS.scrollDepth,
        severity: 'critical',
        description: `Avg scroll depth is ${(data.avgScrollDepth * 100).toFixed(0)}% (benchmark: ${(BENCHMARKS.scrollDepth * 100).toFixed(0)}%)`,
      });
    }
  }

  return issues;
}

// ─── Option Generation ────────────────────────────────────────────────────────

interface RecommendationWithOptions {
  issue: DetectedIssue;
  options: ActionOption[];
  aiRecommendation: string;
  aiRationale: string;
}

export async function generateRecommendations(
  clientId: string,
  issues: DetectedIssue[],
): Promise<RecommendationWithOptions[]> {
  const llm = getLlmService();
  const recommendations: RecommendationWithOptions[] = [];

  for (const issue of issues) {
    // Use LLM to generate contextual options
    const prompt = `
You are an SEO expert analyzing a local service business website.

Issue detected on page "${issue.pagePath}":
- Metric: ${issue.metric}
- Current value: ${issue.currentValue}
- Industry benchmark: ${issue.benchmarkValue}
- Severity: ${issue.severity}

Generate exactly 4 options to address this issue. For each option provide:
1. A short label (max 10 words)
2. A description (1-2 sentences)
3. Risk level: "low", "medium", or "high"
4. Whether it's reversible: true or false
5. Your confidence that this will fix the issue: 0.0 to 1.0

Also provide your top recommendation (option number) and a 1-sentence rationale.

Respond in JSON format:
{
  "options": [
    { "id": "a", "label": "...", "description": "...", "riskLevel": "low|medium|high", "reversible": true|false, "confidence": 0.0-1.0 },
    ...
  ],
  "recommended": "a|b|c|d",
  "rationale": "..."
}`;

    try {
      const response = await llm.extractJson<{
        options: Array<{
          id: string;
          label: string;
          description: string;
          riskLevel: string;
          reversible: boolean;
          confidence: number;
        }>;
        recommended: string;
        rationale: string;
      }>(prompt, clientId, 'behavior-intelligence', `generate-options-${issue.metric}-${issue.pagePath}`);

      const options: ActionOption[] = response.options.map(o => ({
        id: o.id,
        label: o.label,
        description: o.description,
        riskLevel: o.riskLevel as 'low' | 'medium' | 'high',
        reversible: o.reversible,
        recommended: o.id === response.recommended,
        confidence: o.confidence,
      }));

      const recommendedOption = options.find(o => o.id === response.recommended);

      recommendations.push({
        issue,
        options,
        aiRecommendation: recommendedOption?.label || options[0]?.label || 'No recommendation',
        aiRationale: response.rationale,
      });
    } catch (error: any) {
      logger.error({ error: error.message, issue }, 'Failed to generate recommendations');
      
      // Fallback: generate static options based on metric type
      recommendations.push({
        issue,
        options: getStaticOptions(issue),
        aiRecommendation: 'Review content quality',
        aiRationale: 'LLM unavailable — defaulting to content review',
      });
    }
  }

  return recommendations;
}

// ─── Execute Recommendations ──────────────────────────────────────────────────

export async function processRecommendations(
  clientId: string,
  recommendations: RecommendationWithOptions[],
): Promise<{ autoExecuted: number; queuedForApproval: number }> {
  let autoExecuted = 0;
  let queuedForApproval = 0;

  for (const rec of recommendations) {
    const recommendedOption = rec.options.find(o => o.recommended);
    if (!recommendedOption) continue;

    const proposal: ActionProposal = {
      clientId,
      module: 'behavior-intelligence',
      action: `fix_${rec.issue.metric}`,
      description: `${rec.issue.description} on ${rec.issue.pagePath}`,
      rationale: rec.aiRationale,
      triggeredBy: `PostHog data: ${rec.issue.metric} = ${rec.issue.currentValue} (benchmark: ${rec.issue.benchmarkValue})`,
      riskLevel: recommendedOption.riskLevel as 'low' | 'medium' | 'high',
      reversible: recommendedOption.reversible,
      options: rec.options,
      aiRecommendation: rec.aiRecommendation,
      aiConfidence: recommendedOption.confidence,
    };

    const decision = evaluateExecution(proposal);
    await logAction(proposal, decision);

    if (decision.execute) {
      autoExecuted++;
      logger.info({
        page: rec.issue.pagePath,
        metric: rec.issue.metric,
        action: rec.aiRecommendation,
      }, 'Auto-executing behavior recommendation');
    } else {
      queuedForApproval++;
      logger.info({
        page: rec.issue.pagePath,
        metric: rec.issue.metric,
        action: rec.aiRecommendation,
        reason: decision.reason,
      }, 'Queued behavior recommendation for approval');
    }
  }

  return { autoExecuted, queuedForApproval };
}

// ─── Static Fallback Options ──────────────────────────────────────────────────

function getStaticOptions(issue: DetectedIssue): ActionOption[] {
  const optionSets: Record<string, ActionOption[]> = {
    bounce_rate: [
      { id: 'a', label: 'Rewrite CTA copy', description: 'Update the call-to-action to be more compelling and action-oriented', riskLevel: 'low', reversible: true, recommended: true, confidence: 0.7 },
      { id: 'b', label: 'Add social proof above fold', description: 'Insert testimonials or trust badges near the top of the page', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.6 },
      { id: 'c', label: 'Redesign page layout', description: 'Restructure the page to improve visual hierarchy and scannability', riskLevel: 'medium', reversible: true, recommended: false, confidence: 0.5 },
      { id: 'd', label: 'Remove page from navigation', description: 'Remove this underperforming page and redirect traffic elsewhere', riskLevel: 'high', reversible: false, recommended: false, confidence: 0.3 },
    ],
    time_on_page: [
      { id: 'a', label: 'Add more detailed content', description: 'Expand the page with more in-depth information and examples', riskLevel: 'low', reversible: true, recommended: true, confidence: 0.7 },
      { id: 'b', label: 'Add FAQ section', description: 'Include frequently asked questions to increase engagement', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.65 },
      { id: 'c', label: 'Add video content', description: 'Embed a relevant video to increase time on page', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.6 },
      { id: 'd', label: 'Do nothing', description: 'Monitor for another week before taking action', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.3 },
    ],
    scroll_depth: [
      { id: 'a', label: 'Move key content higher', description: 'Restructure to put the most important information above the fold', riskLevel: 'low', reversible: true, recommended: true, confidence: 0.7 },
      { id: 'b', label: 'Add visual breaks', description: 'Insert images, icons, or section dividers to encourage scrolling', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.6 },
      { id: 'c', label: 'Shorten the page', description: 'Remove less relevant content to improve content density', riskLevel: 'medium', reversible: true, recommended: false, confidence: 0.5 },
      { id: 'd', label: 'Add progress indicator', description: 'Show a reading progress bar to encourage completion', riskLevel: 'low', reversible: true, recommended: false, confidence: 0.4 },
    ],
  };

  return optionSets[issue.metric] || optionSets.bounce_rate;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runBehaviorRecommendationCycle(clientId: string): Promise<void> {
  logger.info({ clientId }, 'Starting behavior recommendation cycle');

  const issues = await detectBehaviorIssues(clientId);
  
  if (issues.length === 0) {
    logger.info({ clientId }, 'No behavior issues detected');
    return;
  }

  logger.info({ clientId, issueCount: issues.length }, 'Behavior issues detected');

  const recommendations = await generateRecommendations(clientId, issues);
  const results = await processRecommendations(clientId, recommendations);

  logger.info({
    clientId,
    issues: issues.length,
    autoExecuted: results.autoExecuted,
    queuedForApproval: results.queuedForApproval,
  }, 'Behavior recommendation cycle complete');
}
