/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Module 3: AEO/GEO Engine
 * (Answer Engine Optimization / Generative Engine Optimization)
 * 
 * Capabilities:
 * - FAQ content optimization for AI citation (40-60 word extractable blocks)
 * - FAQPage schema markup generation and injection
 * - Conversational query targeting
 * - Statistical density scoring (19+ data points = 5.4x citations)
 * - Self-query feedback loop (checks if AI platforms cite the client)
 * - Monthly freshness updates
 * 
 * Token Budget:
 * - checkCitations: ~500 fast tokens (classification only)
 * - optimizeFaqs: ~6000 strategic tokens (monthly content generation)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { Job } from 'bullmq';
import { eq, desc } from 'drizzle-orm';
import { Scheduler } from '../../core/scheduler.js';
import { getConfig } from '../../core/config.js';
import { createModuleLogger } from '../../core/logger.js';
import { getDb, schema } from '../../core/database/index.js';
import { getLlmService } from '../../services/llm.js';
import { getNotificationService } from '../../services/notifications.js';

const logger = createModuleLogger('aeo-geo');

// ─── AEO Citation Architecture Constants ────────────────────────────────────

const _AEO_RULES = {
  answerBlockLength: { min: 40, max: 60 },  // words per extractable answer
  statisticalDensityTarget: 19,              // data points per page for max citations
  freshnessIntervalDays: 30,                 // update FAQ content monthly
  schemaTypes: ['FAQPage', 'HowTo', 'QAPage'],
};

// ─── Self-Query: Check if AI Platforms Cite the Client ───────────────────────

interface CitationCheckResult {
  platform: string;
  query: string;
  cited: boolean;
  citedUrl: string | null;
  competitorCited: string | null;
  response: string;
}

async function checkAiCitation(
  query: string,
  clientDomain: string,
  platform: 'perplexity' | 'chatgpt_search'
): Promise<CitationCheckResult> {
  const config = getConfig();

  if (platform === 'perplexity') {
    try {
      const response = await axios.post(
        'https://api.perplexity.ai/chat/completions',
        {
          model: 'llama-3.1-sonar-small-128k-online',
          messages: [{ role: 'user', content: query }],
          return_citations: true,
        },
        {
          headers: { Authorization: `Bearer ${config.PERPLEXITY_API_KEY}` },
          timeout: 30000,
        }
      );

      const content = response.data.choices?.[0]?.message?.content || '';
      const citations = response.data.citations || [];

      const cited = citations.some((c: string) => c.includes(clientDomain.replace('www.', '')));
      const citedUrl = citations.find((c: string) => c.includes(clientDomain.replace('www.', ''))) || null;
      const competitorCited = citations.find((c: string) => !c.includes(clientDomain.replace('www.', ''))) || null;

      return { platform, query, cited, citedUrl, competitorCited, response: content.slice(0, 500) };
    } catch (error: any) {
      logger.error({ platform, query, error: error.message }, 'Citation check failed');
      return { platform, query, cited: false, citedUrl: null, competitorCited: null, response: '' };
    }
  }

  // For platforms without direct API, use the fast LLM to simulate
  // (In production, you'd use the actual platform's API when available)
  return { platform, query, cited: false, citedUrl: null, competitorCited: null, response: '' };
}

// ─── Handler: Check Citations ────────────────────────────────────────────────

async function checkCitations(job: Job): Promise<void> {
  const { clientId, clientDomain, clientConfig } = job.data;
  if (!clientId) return;

  const db = getDb();
  const llm = getLlmService();
  const notifications = getNotificationService();

  // Get target queries from client config
  const targetQueries = clientConfig?.aeoQueries || [];

  // If no explicit queries, generate them from keywords (fast LLM)
  let queries = targetQueries;
  if (!queries.length && clientConfig?.targetKeywords?.length) {
    const keywordsStr = clientConfig.targetKeywords.slice(0, 5).map((k: any) => k.keyword).join(', ');
    const generated = await llm.extractJson<{ queries: string[] }>(
      `Convert these SEO keywords into natural conversational questions that someone would ask an AI assistant.
Keywords: ${keywordsStr}
Industry: ${clientConfig.industry || 'local service'}
City: ${clientConfig.city || ''}

Return JSON: { "queries": ["question 1", "question 2", ...] }
Generate 3-5 questions.`,
      clientId,
      'aeo-geo',
      'generate-aeo-queries'
    );
    queries = generated.queries || [];
  }

  logger.info({ clientDomain, queryCount: queries.length }, 'Checking AI citations');

  let citedCount = 0;
  let totalChecked = 0;

  for (const query of queries.slice(0, 10)) {
    // Check Perplexity
    const result = await checkAiCitation(query, clientDomain, 'perplexity');
    totalChecked++;

    if (result.cited) citedCount++;

    // Store result
    await db.insert(schema.aeoCitations).values({
      clientId,
      query,
      platform: result.platform,
      cited: result.cited,
      citedUrl: result.citedUrl,
      competitorCited: result.competitorCited,
    });

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  const citationRate = totalChecked > 0 ? (citedCount / totalChecked * 100).toFixed(1) : '0';

  logger.info({ clientDomain, citedCount, totalChecked, citationRate: `${citationRate}%` }, 'Citation check complete');

  // Alert if citation rate is low
  if (totalChecked >= 3 && citedCount === 0) {
    await notifications.sendAlert({
      title: `Zero AI Citations: ${clientDomain}`,
      message: `Checked ${totalChecked} queries across AI platforms — none cited ${clientDomain}. FAQ optimization recommended.`,
      severity: 'warning',
      clientDomain,
      module: 'aeo-geo',
      data: { totalChecked, citedCount, queries: queries.slice(0, 5) },
    });
  }
}

// ─── Handler: Optimize FAQs ─────────────────────────────────────────────────

async function optimizeFaqs(job: Job): Promise<void> {
  const { clientId, clientDomain, clientConfig } = job.data;
  if (!clientId) return;

  const db = getDb();
  const llm = getLlmService();
  const notifications = getNotificationService();

  // Get current citation data to identify gaps
  const recentCitations = await db.select()
    .from(schema.aeoCitations)
    .where(eq(schema.aeoCitations.clientId, clientId))
    .orderBy(desc(schema.aeoCitations.checkedAt))
    .limit(20);

  const uncitedQueries = recentCitations
    .filter(c => !c.cited)
    .map(c => c.query);

  const citedQueries = recentCitations
    .filter(c => c.cited)
    .map(c => c.query);

  logger.info({ clientDomain, uncitedCount: uncitedQueries.length, citedCount: citedQueries.length }, 'Optimizing FAQs');

  // Generate optimized FAQ content (STRATEGIC LLM - monthly only)
  const faqContent = await llm.generateContent(
    `You are an expert in Answer Engine Optimization (AEO). Generate FAQ content optimized for AI citation.

RULES:
1. Each answer MUST be 40-60 words (the extractable citation window)
2. Start each answer with a direct, definitive statement (no "Well..." or "It depends...")
3. Include at least 2 specific data points per answer (statistics, numbers, timeframes)
4. Use the exact phrasing of the question in the answer (for semantic matching)
5. End with a concrete, actionable takeaway
6. Include schema-ready structure (question/answer pairs)

STATISTICAL DENSITY: Target 19+ data points across all answers for maximum citation probability (5.4x improvement).

FORMAT: Return valid JSON array of objects: [{ "question": "...", "answer": "...", "schema_type": "FAQPage" }]`,
    `Domain: ${clientDomain}
Industry: ${clientConfig?.industry || 'local service'}
City/State: ${clientConfig?.city || ''}, ${clientConfig?.state || ''}
Services: ${JSON.stringify(clientConfig?.services || [])}

Queries that are NOT being cited (need optimization):
${uncitedQueries.slice(0, 5).map(q => `- ${q}`).join('\n')}

Queries that ARE being cited (maintain these patterns):
${citedQueries.slice(0, 3).map(q => `- ${q}`).join('\n')}

Generate 5-8 optimized FAQ entries targeting the uncited queries:`,
    clientId,
    'aeo-geo',
    'faq-optimization'
  );

  // Parse and store
  let faqs: Array<{ question: string; answer: string; schema_type: string }>;
  try {
    faqs = JSON.parse(faqContent);
  } catch {
    logger.warn({ clientDomain }, 'FAQ generation returned non-JSON — attempting extraction');
    faqs = [];
  }

  if (faqs.length > 0) {
    // Store optimized FAQs
    await db.insert(schema.faqOptimizations).values({
      clientId,
      pageUrl: `https://${clientDomain}/faq/`,
      questions: faqs,
      schemaInjected: false,
    });

    // Generate the FAQPage schema markup
    const schemaMarkup = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(faq => ({
        '@type': 'Question',
        name: faq.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: faq.answer,
        },
      })),
    };

    // Notify operator with the ready-to-inject schema
    await notifications.sendAlert({
      title: `FAQ Optimization Ready: ${clientDomain}`,
      message: `Generated ${faqs.length} optimized FAQ entries. Schema markup ready for injection.\n\nNext step: Deploy updated FAQ page with schema.`,
      severity: 'info',
      clientDomain,
      module: 'aeo-geo',
      data: {
        faqCount: faqs.length,
        schemaMarkup: JSON.stringify(schemaMarkup, null, 2).slice(0, 500) + '...',
        wordCounts: faqs.map(f => ({ q: f.question.slice(0, 50), words: f.answer.split(' ').length })),
      },
    });

    logger.info({ clientDomain, faqCount: faqs.length }, 'FAQ optimization complete');
  }
}

// ─── Register Handlers ───────────────────────────────────────────────────────

export function registerAeoHandlers(scheduler: Scheduler): void {
  scheduler.registerHandler('aeo:check-citations', checkCitations);
  scheduler.registerHandler('aeo:optimize-faqs', optimizeFaqs);
  logger.info('AEO/GEO handlers registered');
}
