/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Module 2: Web Vitals Multi-Signal Tracker
 * 
 * Four independent data sources for triangulated performance monitoring:
 * 1. PageSpeed Insights API (lab data - Lighthouse)
 * 2. Chrome UX Report API (real field data from Chrome users)
 * 3. Self-hosted RUM via web-vitals.js (real-time per-visit, stored in PostHog)
 * 4. Google Search Console API (how Google sees it for ranking)
 * 
 * Token Budget: ZERO — this module is 100% deterministic API calls + DB writes.
 * Alerts are threshold-based, not AI-generated.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Scheduler } from '../../core/scheduler.js';
import { getConfig } from '../../core/config.js';
import { createModuleLogger } from '../../core/logger.js';
import { getDb, schema } from '../../core/database/index.js';
import { getNotificationService } from '../../services/notifications.js';

const logger = createModuleLogger('web-vitals');

// ─── Thresholds (Google's Core Web Vitals standards) ─────────────────────────

const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },     // ms
  inp: { good: 200, poor: 500 },       // ms
  cls: { good: 0.1, poor: 0.25 },      // score
  fcp: { good: 1800, poor: 3000 },     // ms
  ttfb: { good: 800, poor: 1800 },     // ms
};

function rateMetric(metric: string, value: number): 'good' | 'needs_improvement' | 'poor' {
  const threshold = THRESHOLDS[metric as keyof typeof THRESHOLDS];
  if (!threshold) return 'good';
  if (value <= threshold.good) return 'good';
  if (value >= threshold.poor) return 'poor';
  return 'needs_improvement';
}

function overallRating(metrics: Record<string, number | null>): 'good' | 'needs_improvement' | 'poor' {
  const ratings = Object.entries(metrics)
    .filter(([_, v]) => v !== null)
    .map(([k, v]) => rateMetric(k, v!));

  if (ratings.includes('poor')) return 'poor';
  if (ratings.includes('needs_improvement')) return 'needs_improvement';
  return 'good';
}

// ─── Source 1: PageSpeed Insights API ────────────────────────────────────────

async function fetchPageSpeedInsights(url: string, device: 'mobile' | 'desktop'): Promise<{
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
} | null> {
  const config = getConfig();

  try {
    const response = await axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
      params: {
        url,
        key: config.PAGESPEED_API_KEY,
        strategy: device,
        category: 'performance',
      },
      timeout: 60000,
    });

    const metrics = response.data.lighthouseResult?.audits;
    if (!metrics) return null;

    return {
      lcp: metrics['largest-contentful-paint']?.numericValue || null,
      inp: metrics['interaction-to-next-paint']?.numericValue || null,
      cls: metrics['cumulative-layout-shift']?.numericValue || null,
      fcp: metrics['first-contentful-paint']?.numericValue || null,
      ttfb: metrics['server-response-time']?.numericValue || null,
    };
  } catch (error: any) {
    logger.error({ url, device, error: error.message }, 'PSI fetch failed');
    return null;
  }
}

// ─── Source 2: Chrome UX Report (CrUX) API ───────────────────────────────────

async function fetchCruxData(origin: string, device: 'PHONE' | 'DESKTOP'): Promise<{
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
} | null> {
  const config = getConfig();

  try {
    const response = await axios.post(
      `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${config.PAGESPEED_API_KEY}`,
      {
        origin,
        formFactor: device,
        metrics: [
          'largest_contentful_paint',
          'interaction_to_next_paint',
          'cumulative_layout_shift',
          'first_contentful_paint',
          'experimental_time_to_first_byte',
        ],
      },
      { timeout: 30000 }
    );

    const record = response.data.record?.metrics;
    if (!record) return null;

    const getP75 = (metric: any) => metric?.percentiles?.p75 || null;

    return {
      lcp: getP75(record.largest_contentful_paint),
      inp: getP75(record.interaction_to_next_paint),
      // CrUX returns CLS as an unscaled fraction (e.g. 0.12) — same units as the
      // PSI path. Do NOT divide by 100 (that turned a "poor" 0.30 into 0.003,
      // which rates "good" and suppresses the alert).
      cls: getP75(record.cumulative_layout_shift),
      fcp: getP75(record.first_contentful_paint),
      ttfb: getP75(record.experimental_time_to_first_byte),
    };
  } catch (error: any) {
    // CrUX returns 404 for sites without enough traffic data
    if (error.response?.status === 404) {
      logger.debug({ origin }, 'No CrUX data available (insufficient traffic)');
    } else {
      logger.error({ origin, error: error.message }, 'CrUX fetch failed');
    }
    return null;
  }
}

// ─── Source 3: PostHog RUM (web-vitals.js events) ────────────────────────────

async function fetchRumFromPosthog(clientId: string, _domain: string): Promise<{
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
} | null> {
  const config = getConfig();
  const db = getDb();

  // Get client's PostHog project details
  const [client] = await db.select()
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  if (!client?.posthogApiKey || !client?.posthogProjectId) {
    logger.debug({ clientId }, 'No PostHog config — skipping RUM');
    return null;
  }

  try {
    // Query PostHog for web-vitals events from last 24h
    const response = await axios.post(
      `${config.POSTHOG_API_URL}/api/projects/${client.posthogProjectId}/query`,
      {
        query: {
          kind: 'HogQLQuery',
          query: `
            SELECT
              avg(toFloat64OrNull(JSONExtractString(properties, 'lcp'))) as avg_lcp,
              avg(toFloat64OrNull(JSONExtractString(properties, 'inp'))) as avg_inp,
              avg(toFloat64OrNull(JSONExtractString(properties, 'cls'))) as avg_cls,
              avg(toFloat64OrNull(JSONExtractString(properties, 'fcp'))) as avg_fcp,
              avg(toFloat64OrNull(JSONExtractString(properties, 'ttfb'))) as avg_ttfb
            FROM events
            WHERE event = 'web_vitals'
              AND timestamp > now() - interval 1 day
          `,
        },
      },
      {
        // Query API needs a PostHog PERSONAL API key. client.posthogApiKey is
        // the per-project ingestion key (used client-side in the tracking
        // snippet) and would 401 here. All clients share one PostHog instance
        // (per-client projects), so the global personal key can read any project.
        headers: { Authorization: `Bearer ${config.POSTHOG_PERSONAL_API_KEY}` },
        timeout: 30000,
      }
    );

    const results = response.data?.results?.[0];
    if (!results) return null;

    return {
      lcp: results[0] || null,
      inp: results[1] || null,
      cls: results[2] || null,
      fcp: results[3] || null,
      ttfb: results[4] || null,
    };
  } catch (error: any) {
    logger.error({ clientId, error: error.message }, 'PostHog RUM fetch failed');
    return null;
  }
}

// ─── Source 4: Google Search Console (Core Web Vitals report) ─────────────────

async function fetchSearchConsoleVitals(domain: string): Promise<{
  lcp: number | null;
  inp: number | null;
  cls: number | null;
} | null> {
  // Note: GSC Core Web Vitals data requires OAuth2 service account.
  // This is a simplified implementation — full implementation would use
  // google-auth-library with the service account JSON.
  // For now, we rely on PSI + CrUX as primary sources.
  logger.debug({ domain }, 'GSC vitals: using PSI/CrUX as proxy (service account not configured)');
  return null;
}

// ─── Main Handler: Check All Sources ─────────────────────────────────────────

async function checkAllSources(job: Job): Promise<void> {
  const { clientId, clientDomain } = job.data;
  if (!clientId) return;

  const db = getDb();
  const notifications = getNotificationService();
  const url = `https://${clientDomain}`;

  logger.info({ clientDomain }, 'Running multi-signal vitals check');

  const sources: Array<{ name: string; device: string; data: any }> = [];

  // Source 1: PSI (Mobile)
  const psiMobile = await fetchPageSpeedInsights(url, 'mobile');
  if (psiMobile) {
    sources.push({ name: 'psi', device: 'mobile', data: psiMobile });
    await db.insert(schema.webVitals).values({
      clientId, url, source: 'psi', device: 'mobile',
      lcp: psiMobile.lcp, inp: psiMobile.inp, cls: psiMobile.cls,
      fcp: psiMobile.fcp, ttfb: psiMobile.ttfb,
      rating: overallRating(psiMobile),
    });
  }

  // Source 1b: PSI (Desktop)
  const psiDesktop = await fetchPageSpeedInsights(url, 'desktop');
  if (psiDesktop) {
    sources.push({ name: 'psi', device: 'desktop', data: psiDesktop });
    await db.insert(schema.webVitals).values({
      clientId, url, source: 'psi', device: 'desktop',
      lcp: psiDesktop.lcp, inp: psiDesktop.inp, cls: psiDesktop.cls,
      fcp: psiDesktop.fcp, ttfb: psiDesktop.ttfb,
      rating: overallRating(psiDesktop),
    });
  }

  // Source 2: CrUX (Mobile)
  const cruxMobile = await fetchCruxData(url, 'PHONE');
  if (cruxMobile) {
    sources.push({ name: 'crux', device: 'mobile', data: cruxMobile });
    await db.insert(schema.webVitals).values({
      clientId, url, source: 'crux', device: 'mobile',
      lcp: cruxMobile.lcp, inp: cruxMobile.inp, cls: cruxMobile.cls,
      fcp: cruxMobile.fcp, ttfb: cruxMobile.ttfb,
      rating: overallRating(cruxMobile),
    });
  }

  // Source 3: PostHog RUM
  const rum = await fetchRumFromPosthog(clientId, clientDomain);
  if (rum) {
    sources.push({ name: 'rum', device: 'all', data: rum });
    await db.insert(schema.webVitals).values({
      clientId, url, source: 'rum', device: 'mobile',
      lcp: rum.lcp, inp: rum.inp, cls: rum.cls,
      fcp: rum.fcp, ttfb: rum.ttfb,
      rating: overallRating(rum),
    });
  }

  // Source 4: GSC
  const gsc = await fetchSearchConsoleVitals(clientDomain);
  if (gsc) {
    sources.push({ name: 'search_console', device: 'mobile', data: gsc });
    await db.insert(schema.webVitals).values({
      clientId, url, source: 'search_console', device: 'mobile',
      lcp: gsc.lcp, inp: gsc.inp, cls: gsc.cls,
      fcp: null, ttfb: null,
      rating: overallRating(gsc),
    });
  }

  // ─── Cross-Source Disagreement Detection ─────────────────────────────────
  // If two sources disagree on rating, flag for investigation
  const ratings = sources.map(s => ({ source: s.name, rating: overallRating(s.data) }));
  const hasDisagreement = ratings.some(r => r.rating === 'poor') && ratings.some(r => r.rating === 'good');

  if (hasDisagreement) {
    logger.warn({ clientDomain, ratings }, 'Source disagreement detected');
    await notifications.sendAlert({
      title: 'Vitals Source Disagreement',
      message: `Multiple sources disagree on performance rating for ${clientDomain}. Manual investigation recommended.`,
      severity: 'warning',
      clientDomain,
      module: 'web-vitals',
      data: { ratings },
    });
  }

  // ─── Critical Alert: Any source reports "poor" ───────────────────────────
  const poorSources = sources.filter(s => overallRating(s.data) === 'poor');
  if (poorSources.length > 0) {
    const worstMetrics = poorSources.map(s => {
      const metrics = s.data;
      return Object.entries(metrics)
        .filter(([_, v]) => v !== null && rateMetric(_, v as number) === 'poor')
        .map(([k, v]) => `${k}: ${v}`);
    }).flat();

    await notifications.sendAlert({
      title: `Poor Core Web Vitals: ${clientDomain}`,
      message: `${poorSources.length} source(s) report POOR performance.\nFailing metrics: ${worstMetrics.join(', ')}`,
      severity: 'critical',
      clientDomain,
      module: 'web-vitals',
      data: { poorSources: poorSources.map(s => s.name), metrics: worstMetrics },
    });
  }

  logger.info({ clientDomain, sourcesChecked: sources.length, ratings }, 'Vitals check complete');
}

// ─── Register Handlers ───────────────────────────────────────────────────────

export function registerVitalsHandlers(scheduler: Scheduler): void {
  scheduler.registerHandler('vitals:check-all-sources', checkAllSources);
  logger.info('Web Vitals handlers registered');
}
