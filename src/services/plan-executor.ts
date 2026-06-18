/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Surpass Plan Executor (GAP-07)
 *
 * Closes the kill-chain gap: generateSurpassPlan writes status='planned'
 * but nothing executed the plan. This service reads status='planned' gap
 * analyses, routes each autonomous action through the execution policy,
 * dispatches to site-deployment.ts, and marks status='executing'.
 *
 * Registered as BullMQ job: 'serp:execute-surpass-plans'
 * Runs after: serp:generate-surpass-plan
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Job } from 'bullmq';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from '../core/database/index.js';
import { createModuleLogger } from '../core/logger.js';
import {
  evaluateExecution,
  createProposal,
  logAction,
} from '../core/execution-policy.js';
import {
  updateMetaTitle,
  updateMetaDescription,
  injectSchema,
  updateHeading,
  rewritePageContent,
  updateFaq,
  triggerVercelDeploy,
} from './site-deployment.js';
import type { SurpassAction } from '../types/index.js';

const logger = createModuleLogger('plan-executor');

// Maps action strings from surpass plan to deployment functions.
// Covers the most common autonomous actions from execution-policy taxonomy.
type ActionDispatcher = (action: SurpassAction, clientDomain: string, clientUrl: string | null) => Promise<void>;

const ACTION_DISPATCH_MAP: Record<string, ActionDispatcher> = {
  meta_title_update: async (action, clientDomain, clientUrl) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newTitle = extractValue(action.action, 'title');
    if (filePath && newTitle) await updateMetaTitle(filePath, newTitle, clientDomain);
  },
  meta_description_update: async (action, clientDomain, clientUrl) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newDesc = extractValue(action.action, 'description');
    if (filePath && newDesc) await updateMetaDescription(filePath, newDesc, clientDomain);
  },
  heading_optimization: async (action, clientDomain, clientUrl) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newHeading = extractValue(action.action, 'heading');
    if (filePath && newHeading) await updateHeading(filePath, newHeading, clientDomain);
  },
  faq_content_update: async (action, clientDomain, clientUrl) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    // FAQ actions are dispatched to site-deployment; actual FAQ content
    // generation happens in aeo-geo module and is passed via action.metadata.
    if (filePath) {
      await updateFaq(filePath, [], clientDomain); // executor passes empty; aeo-geo fills later
    }
  },
  schema_markup_injection: async (action, clientDomain, clientUrl) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    if (filePath) {
      await injectSchema(filePath, 'LocalBusiness', {}, clientDomain);
    }
  },
};

/**
 * Convert a live URL to a relative source file path.
 * e.g. https://example.com/services/ → src/pages/services/index.astro
 */
function urlToFilePath(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const clean = pathname.replace(/\/$/, '') || '/index';
    return `src/pages${clean}.astro`;
  } catch {
    return null;
  }
}

/**
 * Extract a quoted or colon-separated value from an action description string.
 * e.g. 'Update title: "Best Roofer Austin TX"' → 'Best Roofer Austin TX'
 */
function extractValue(actionText: string, _key: string): string | null {
  const quoted = actionText.match(/["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]/);
  if (quoted) return quoted[1];
  const afterColon = actionText.match(/:\s*(.+)$/);
  if (afterColon) return afterColon[1].trim();
  return null;
}

/**
 * Main executor — BullMQ job handler.
 * Reads all status='planned' gap analyses for the client,
 * routes each autonomous action through execution policy,
 * dispatches to site-deployment service.
 */
export async function executeSurpassPlans(job: Job): Promise<void> {
  const { clientId, clientDomain } = job.data;
  if (!clientId) return;

  const db = getDb();

  const plannedGaps = await db.select()
    .from(schema.gapAnalyses)
    .where(and(
      eq(schema.gapAnalyses.clientId, clientId),
      eq(schema.gapAnalyses.status, 'planned'),
    ))
    .orderBy(desc(schema.gapAnalyses.generatedAt))
    .limit(5);

  if (!plannedGaps.length) {
    logger.info({ clientDomain }, 'No planned gap analyses — executor idle');
    return;
  }

  logger.info({ clientDomain, count: plannedGaps.length }, 'Executing surpass plans');

  let anyDeployed = false;

  for (const gap of plannedGaps) {
    const surpassPlan = (gap.surpassPlan as SurpassAction[]) ?? [];
    const autonomousActions = surpassPlan.filter(a => a.autonomous && a.status === 'pending');

    if (!autonomousActions.length) {
      await db.update(schema.gapAnalyses)
        .set({ status: 'executing' })
        .where(eq(schema.gapAnalyses.id, gap.id));
      continue;
    }

    for (const action of autonomousActions) {
      const actionType = inferActionType(action.action);
      const proposal = createProposal({
        clientId,
        module: 'serp-intelligence',
        action: actionType,
        description: action.action,
        rationale: `Surpass plan for keyword: ${gap.keyword}. Impact: ${action.impact}, Effort: ${action.effort}`,
        triggeredBy: `gap-analysis:${gap.keyword}`,
        estimatedImpact: action.impact,
      });

      const decision = evaluateExecution(proposal);
      await logAction(proposal, decision);

      if (!decision.execute) {
        logger.info({ action: action.action, keyword: gap.keyword }, 'Action queued for approval (CRITICAL)');
        continue;
      }

      try {
        const dispatcher = ACTION_DISPATCH_MAP[actionType];
        if (dispatcher) {
          await dispatcher(action, clientDomain, gap.clientUrl);
          anyDeployed = true;
          logger.info({ actionType, keyword: gap.keyword }, 'Action dispatched to site-deployment');
        } else {
          logger.warn({ actionType }, 'No dispatcher for action type — skipping');
        }
      } catch (err: any) {
        logger.error({ actionType, keyword: gap.keyword, error: err.message }, 'Dispatch failed');
      }
    }

    await db.update(schema.gapAnalyses)
      .set({ status: 'executing' })
      .where(eq(schema.gapAnalyses.id, gap.id));
  }

  if (anyDeployed) {
    await triggerVercelDeploy();
    logger.info({ clientDomain }, 'Vercel deploy triggered after surpass plan execution');
  }
}

/**
 * Infer the execution-policy action type from a free-text action description.
 * Maps common patterns to ACTION_TAXONOMY keys.
 */
function inferActionType(actionText: string): string {
  const lower = actionText.toLowerCase();
  if (lower.includes('meta title') || lower.includes('title tag')) return 'meta_title_update';
  if (lower.includes('meta description') || lower.includes('description')) return 'meta_description_update';
  if (lower.includes('h1') || lower.includes('heading')) return 'heading_optimization';
  if (lower.includes('faq') || lower.includes('question')) return 'faq_content_update';
  if (lower.includes('schema') || lower.includes('json-ld') || lower.includes('structured data')) return 'schema_markup_injection';
  if (lower.includes('content') || lower.includes('rewrite')) return 'page_content_rewrite';
  if (lower.includes('internal link')) return 'internal_link_add';
  return 'competitor_surpass_execute';
}

export function registerPlanExecutorHandlers(scheduler: any): void {
  scheduler.registerHandler('serp:execute-surpass-plans', executeSurpassPlans);
  logger.info('Plan executor handler registered');
}
