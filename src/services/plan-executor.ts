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
  triggerVercelDeploy,
  siteConfigFromClient,
  type SiteDeploymentConfig,
} from './site-deployment.js';
import type { SurpassAction } from '../types/index.js';

const logger = createModuleLogger('plan-executor');

// Maps action strings from surpass plan to deployment functions.
// Covers the most common autonomous actions from execution-policy taxonomy.
// 4th arg `siteConfig` carries the per-client transport target (multi-tenant),
// so each client's edits write to THAT client's repo/hook. Dispatchers that
// perform no write ignore it (`_siteConfig`).
type ActionDispatcher = (
  action: SurpassAction,
  clientDomain: string,
  clientUrl: string | null,
  siteConfig: SiteDeploymentConfig,
) => Promise<void>;

const ACTION_DISPATCH_MAP: Record<string, ActionDispatcher> = {
  meta_title_update: async (action, clientDomain, clientUrl, siteConfig) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newTitle = extractValue(action.action, 'title');
    if (filePath && newTitle) await updateMetaTitle(filePath, newTitle, clientDomain, siteConfig);
  },
  meta_description_update: async (action, clientDomain, clientUrl, siteConfig) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newDesc = extractValue(action.action, 'description');
    if (filePath && newDesc) await updateMetaDescription(filePath, newDesc, clientDomain, siteConfig);
  },
  heading_optimization: async (action, clientDomain, clientUrl, siteConfig) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    const newHeading = extractValue(action.action, 'heading');
    if (filePath && newHeading) await updateHeading(filePath, newHeading, clientDomain, siteConfig);
  },
  faq_content_update: async (_action, clientDomain, _clientUrl, _siteConfig) => {
    // SurpassAction carries no FAQ payload (no metadata field), and deploying an
    // empty FAQPage is a no-op at best / overwrites real schema at worst. Skip
    // until FAQ content is threaded in (aeo-geo owns FAQ generation).
    logger.warn({ clientDomain }, 'faq_content_update skipped — no FAQ payload on SurpassAction');
  },
  schema_markup_injection: async (_action, clientDomain, clientUrl, siteConfig) => {
    if (!clientUrl) return;
    const filePath = urlToFilePath(clientUrl);
    if (!filePath) return;
    // Inject a minimal but VALID LocalBusiness object — never empty `{}`, which
    // would write invalid JSON-LD (no @context/@type). aeo-geo enriches later.
    await injectSchema(
      filePath,
      'LocalBusiness',
      { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: clientDomain, url: clientUrl },
      clientDomain,
      siteConfig,
    );
  },
};

/**
 * Convert a live URL to a relative source file path.
 * e.g. https://example.com/services/ → src/pages/services/index.astro
 */
function urlToFilePath(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const clean = pathname.replace(/\/+$/, '');
    return clean === '' ? 'src/pages/index.astro' : `src/pages${clean}/index.astro`;
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

  // Resolve this client's per-tenant deploy target. The scheduler fan-out
  // attaches the full `clients.config` jsonb as `job.data.clientConfig`; never
  // assume it's present. `siteConfigFromClient` forces dry-run when the target
  // repo/token is absent or blank, so an unconfigured client never writes live.
  const siteConfig = siteConfigFromClient(job.data.clientConfig);
  if (siteConfig.dryRun) {
    logger.warn({ clientId, clientDomain }, 'Maintenance transport is not ready — leaving planned work untouched');
    return;
  }

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

    let dispatchAttempts = 0;
    let dispatchSuccesses = 0;

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

      const dispatcher = ACTION_DISPATCH_MAP[actionType];
      if (!dispatcher) {
        logger.warn({ actionType }, 'No dispatcher for action type — skipping');
        continue;
      }

      dispatchAttempts += 1;
      try {
        await dispatcher(action, clientDomain, gap.clientUrl, siteConfig);
        dispatchSuccesses += 1;
        anyDeployed = true;
        logger.info({ actionType, keyword: gap.keyword }, 'Action dispatched to site-deployment');
      } catch (err: any) {
        logger.error({ actionType, keyword: gap.keyword, error: err.message }, 'Dispatch failed');
      }
    }

    // If we attempted real dispatches and every one failed, do NOT advance to
    // 'executing' — that would silently lose the planned work, since the next
    // run only re-selects status='planned'. Leave it 'planned' so it is retried.
    if (dispatchAttempts > 0 && dispatchSuccesses === 0) {
      logger.error(
        { gapId: gap.id, keyword: gap.keyword, attempts: dispatchAttempts },
        'All dispatches failed for gap — leaving status=planned for retry',
      );
      continue;
    }

    await db.update(schema.gapAnalyses)
      .set({ status: 'executing' })
      .where(eq(schema.gapAnalyses.id, gap.id));
  }

  if (anyDeployed) {
    await triggerVercelDeploy(siteConfig);
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
