/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - DataForSEO primitive (single client)
 *
 * The one and only DataForSEO client for the whole bot. Extracted verbatim from
 * the SERP Intelligence module so scheduled rank-tracking behavior is preserved
 * byte-for-byte, and reused by the build-time CompetitiveLandscape producer.
 *
 * ZERO tokens: pure HTTP + parsing. No LLM anywhere in this file.
 *
 * Surface:
 *   - getOrganicSerp(...)     raw organic SERP truth (rank, url, domain) for
 *                             CompetitiveLandscape. NEW — organic-only, no
 *                             client/competitor bucketing.
 *   - getRankings(...)        client-vs-competitor view used by scheduled jobs.
 *   - getPageContent(...)     deterministic on-page content metrics.
 *   - getBacklinkProfile(...) backlink summary metrics.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { getConfig } from '../core/config.js';

/** A single organic SERP result, normalized for ranking-truth consumers. */
export interface OrganicSerpItem {
  /** Absolute position across all SERP item types (matches scheduled tracking). */
  rankAbsolute: number;
  /** Position within organic results only. */
  rankGroup: number;
  /** The exact ranking URL as observed. */
  url: string;
  /** Hostname with a leading `www.` stripped (observation-level normalization). */
  domain: string;
  title: string;
  snippet: string;
}

/** Deterministic organic SERP observation set for one query. */
export interface OrganicSerpResult {
  keyword: string;
  locationName: string;
  languageName: string;
  device: 'desktop' | 'mobile';
  /**
   * SERP capture time as reported by DataForSEO (`result.datetime`), falling
   * back to the provider task time. Sourced from the response — never
   * wall-clock — so identical fixtures yield identical downstream digests.
   */
  observedAt: string;
  serpFeatures: string[];
  items: OrganicSerpItem[];
}

export class DataForSeoClient {
  private readonly baseUrl = 'https://api.dataforseo.com/v3';
  private readonly auth: string;

  constructor() {
    const config = getConfig();
    this.auth = Buffer.from(`${config.DATAFORSEO_LOGIN}:${config.DATAFORSEO_PASSWORD}`).toString('base64');
  }

  private async request(endpoint: string, data: any[]): Promise<any> {
    const response = await axios.post(`${this.baseUrl}${endpoint}`, data, {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (response.data.status_code !== 20000) {
      throw new Error(`DataForSEO error: ${response.data.status_message}`);
    }

    return response.data;
  }

  /**
   * Raw organic SERP truth for a single query. Organic items only; non-organic
   * SERP features (ads, PAA, local pack, …) are excluded from ranking authority
   * but their type labels are surfaced in `serpFeatures`.
   */
  async getOrganicSerp(params: {
    keyword: string;
    locationName?: string;
    languageName?: string;
    device?: 'desktop' | 'mobile';
    depth?: number;
  }): Promise<OrganicSerpResult> {
    const locationName = params.locationName ?? 'United States';
    const languageName = params.languageName ?? 'English';
    const device = params.device ?? 'desktop';
    const result = await this.request('/serp/google/organic/live/advanced', [{
      keyword: params.keyword,
      location_name: locationName,
      language_name: languageName,
      device,
      depth: params.depth ?? 20,
    }]);

    // Task-level errors (e.g. invalid location_name) return `result: null` with a
    // top-level 20000. Treat them as failures instead of silently producing zero
    // organic items — a real provider error must not masquerade as "no results".
    const taskContainer = result.tasks?.[0];
    if (taskContainer?.status_code !== undefined && taskContainer.status_code !== 20000) {
      throw new Error(`DataForSEO task error: ${taskContainer.status_message ?? 'unknown'} (status ${taskContainer.status_code})`);
    }
    if (!Array.isArray(taskContainer?.result) || taskContainer.result.length === 0) {
      throw new Error(`DataForSEO task error: ${taskContainer?.status_message ?? 'no result returned'} (status ${taskContainer?.status_code ?? 'unknown'})`);
    }
    const task = taskContainer.result[0];
    const rawItems = task?.items || [];
    const serpFeatures: string[] = task?.item_types || [];
    const observedAt = normalizeSerpDatetime(task?.datetime) ?? taskContainer.time ?? '';

    const items: OrganicSerpItem[] = [];
    for (const item of rawItems) {
      if (item.type !== 'organic') continue;
      if (typeof item.url !== 'string') continue;
      let domain: string;
      try {
        domain = new URL(item.url).hostname.replace('www.', '');
      } catch {
        continue; // unparseable URL cannot be ranking truth
      }
      items.push({
        rankAbsolute: item.rank_absolute,
        rankGroup: item.rank_group ?? item.rank_absolute,
        url: item.url,
        domain,
        title: item.title || '',
        snippet: item.description || '',
      });
    }

    return { keyword: params.keyword, locationName, languageName, device, observedAt, serpFeatures, items };
  }

  async getRankings(keyword: string, domain: string, location: string = 'United States'): Promise<{
    position: number | null;
    url: string | null;
    serpFeatures: string[];
    competitors: Array<{ domain: string; position: number; url: string; title: string; snippet: string }>;
  }> {
    const result = await this.request('/serp/google/organic/live/advanced', [{
      keyword,
      location_name: location,
      language_name: 'English',
      device: 'desktop',
      depth: 20,
    }]);

    const items = result.tasks?.[0]?.result?.[0]?.items || [];
    const serpFeatures = result.tasks?.[0]?.result?.[0]?.item_types || [];

    let position: number | null = null;
    let url: string | null = null;
    const competitors: Array<{ domain: string; position: number; url: string; title: string; snippet: string }> = [];

    for (const item of items) {
      if (item.type !== 'organic') continue;

      const itemDomain = new URL(item.url).hostname.replace('www.', '');

      if (itemDomain === domain.replace('www.', '')) {
        position = item.rank_absolute;
        url = item.url;
      } else {
        competitors.push({
          domain: itemDomain,
          position: item.rank_absolute,
          url: item.url,
          title: item.title || '',
          snippet: item.description || '',
        });
      }
    }

    return { position, url, serpFeatures, competitors };
  }

  async getBacklinkProfile(domain: string): Promise<{
    totalBacklinks: number;
    referringDomains: number;
    domainRating: number;
  }> {
    const result = await this.request('/backlinks/summary/live', [{
      target: domain,
      internal_list_limit: 0,
    }]);

    const data = result.tasks?.[0]?.result?.[0] || {};
    return {
      totalBacklinks: data.total_backlinks || 0,
      referringDomains: data.referring_domains || 0,
      domainRating: data.rank || 0,
    };
  }

  async getPageContent(url: string): Promise<{
    wordCount: number;
    headings: number;
    images: number;
    internalLinks: number;
    externalLinks: number;
  }> {
    const result = await this.request('/on_page/instant_pages', [{
      url,
      load_resources: false,
    }]);

    const page = result.tasks?.[0]?.result?.[0]?.items?.[0] || {};
    return {
      wordCount: page.meta?.content?.plain_text_word_count || 0,
      headings: (page.meta?.htags?.h1?.length || 0) + (page.meta?.htags?.h2?.length || 0) + (page.meta?.htags?.h3?.length || 0),
      images: page.meta?.images_count || 0,
      internalLinks: page.meta?.internal_links_count || 0,
      externalLinks: page.meta?.external_links_count || 0,
    };
  }
}

/**
 * Normalize DataForSEO's `datetime` (`YYYY-MM-DD HH:MM:SS +00:00`) to an ISO
 * 8601 string. Returns undefined for an absent/unparseable value so the caller
 * can fall back deterministically.
 */
export function normalizeSerpDatetime(datetime: unknown): string | undefined {
  if (typeof datetime !== 'string' || !datetime.trim()) return undefined;
  const parsed = new Date(datetime.replace(' ', 'T').replace(' ', ''));
  return Number.isNaN(parsed.getTime()) ? datetime : parsed.toISOString();
}
