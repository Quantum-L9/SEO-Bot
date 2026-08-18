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

import axios from "axios";
import { getConfig } from "../core/config.js";

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
  device: "desktop" | "mobile";
  /**
   * SERP capture time as reported by DataForSEO (`result.datetime`), falling
   * back to the provider task time. Sourced from the response — never
   * wall-clock — so identical fixtures yield identical downstream digests.
   */
  observedAt: string;
  serpFeatures: string[];
  items: OrganicSerpItem[];
}

/**
 * Transport / account / top-level API failure. The provider could not be reached
 * or refused the request — there is no SERP evidence, and none may be inferred.
 */
export class DataForSeoUnavailableError extends Error {
  readonly code = "DATAFORSEO_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoUnavailableError";
  }
}

/**
 * The request reached DataForSEO but the individual task failed (bad location,
 * quota, provider-side error). Distinct from a task that legitimately returned
 * zero organic results — that is a VALID EMPTY RESULT and returns normally.
 */
export class DataForSeoTaskError extends Error {
  readonly code = "DATAFORSEO_TASK_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoTaskError";
  }
}

/** The task succeeded but its payload is not usable ranking evidence. */
export class SerpEvidenceInvalidError extends Error {
  readonly code = "SERP_EVIDENCE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "SerpEvidenceInvalidError";
  }
}

/** One initial attempt plus at most one retry, transient conditions only. */
const MAX_DATAFORSEO_ATTEMPTS = 2;
/** HTTP statuses that indicate a transient provider-side condition. */
const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
/** Default backoff when no Retry-After is present (~500 ms per the contract). */
const RETRY_DELAY_MS = 500;
/** Retry-After cap: honor the header but never wait more than ~2 seconds. */
const RETRY_AFTER_CAP_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-attempt telemetry; never contains credentials or auth headers. */
export interface DataForSeoAttemptRecord {
  endpoint: string;
  attempt: number;
  status: string;
  retry: boolean;
}

export function retryAfterDelayMs(error: unknown): number {
  if (!axios.isAxiosError(error)) return RETRY_DELAY_MS;
  const header = error.response?.headers?.["retry-after"];
  const seconds = typeof header === "string" ? Number(header) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_DELAY_MS;
  return Math.min(Math.round(seconds * 1000), RETRY_AFTER_CAP_MS);
}

export function failureClass(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status}`;
    if (error.code === "ECONNABORTED") return "timeout";
    return error.code ?? "network";
  }
  return error instanceof Error ? error.name : "unknown";
}

/** Transient transport/provider failures only; deterministic failures never. */
export function isRetryableTransportFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response) return RETRYABLE_HTTP_STATUS.has(error.response.status);
  // No response: connection reset / establishment failure / bounded timeout.
  return true;
}

export class DataForSeoClient {
  private readonly baseUrl = "https://api.dataforseo.com/v3";
  private readonly auth: string;
  private readonly attemptLog: DataForSeoAttemptRecord[] = [];

  constructor() {
    const config = getConfig();
    this.auth = Buffer.from(`${config.DATAFORSEO_LOGIN}:${config.DATAFORSEO_PASSWORD}`).toString(
      "base64",
    );
  }

  /** Total provider attempts across all calls — DataForSEO requests are billable. */
  get providerAttempts(): number {
    return this.attemptLog.length;
  }

  /** Per-attempt telemetry (endpoint, attempt, status class, retry flag). */
  getProviderAttemptLog(): readonly DataForSeoAttemptRecord[] {
    return this.attemptLog;
  }

  private async requestOnce(endpoint: string, data: any[]): Promise<any> {
    let response: { data: any };
    try {
      response = await axios.post(`${this.baseUrl}${endpoint}`, data, {
        headers: {
          Authorization: `Basic ${this.auth}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      });
    } catch (error) {
      // Re-thrown as the raw axios error so the retry loop can classify it.
      throw error;
    }

    if (response.data?.status_code !== 20000) {
      throw new DataForSeoUnavailableError(
        `DataForSEO error: ${response.data?.status_message ?? "unknown"} (status ${response.data?.status_code ?? "unknown"})`,
      );
    }

    return response.data;
  }

  private async request(endpoint: string, data: any[]): Promise<any> {
    for (let attempt = 1; attempt <= MAX_DATAFORSEO_ATTEMPTS; attempt++) {
      try {
        const result = await this.requestOnce(endpoint, data);
        this.attemptLog.push({ endpoint, attempt, status: "ok", retry: false });
        return result;
      } catch (error) {
        // Provider/task-level errors (the 20000-status guard above) are
        // deterministic: classify and fail without retrying.
        if (error instanceof DataForSeoUnavailableError) {
          this.attemptLog.push({ endpoint, attempt, status: "provider", retry: false });
          throw error;
        }
        const status = failureClass(error);
        const retry = attempt < MAX_DATAFORSEO_ATTEMPTS && isRetryableTransportFailure(error);
        this.attemptLog.push({ endpoint, attempt, status, retry });
        if (!retry) {
          // Transport-class failures become DATAFORSEO_UNAVAILABLE; task-level
          // and evidence errors keep their distinct classes (unchanged from
          // before this retry was added).
          if (axios.isAxiosError(error)) {
            throw new DataForSeoUnavailableError(
              `DataForSEO request to ${endpoint} failed: ${error.message}`,
            );
          }
          throw error;
        }
        await sleep(retryAfterDelayMs(error));
      }
    }
    throw new DataForSeoUnavailableError(`DataForSEO request to ${endpoint} exhausted retries`);
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
    device?: "desktop" | "mobile";
    depth?: number;
  }): Promise<OrganicSerpResult> {
    const locationName = params.locationName ?? "United States";
    const languageName = params.languageName ?? "English";
    const device = params.device ?? "desktop";
    const result = await this.request("/serp/google/organic/live/advanced", [
      {
        keyword: params.keyword,
        location_name: locationName,
        language_name: languageName,
        device,
        depth: params.depth ?? 20,
      },
    ]);

    // Task-level errors (e.g. invalid location_name) return `result: null` with a
    // top-level 20000. Treat them as failures instead of silently producing zero
    // organic items — a real provider error must not masquerade as "no results".
    const taskContainer = result.tasks?.[0];
    if (taskContainer?.status_code !== undefined && taskContainer.status_code !== 20000) {
      throw new DataForSeoTaskError(
        `DataForSEO task error: ${taskContainer.status_message ?? "unknown"} (status ${taskContainer.status_code})`,
      );
    }
    if (!Array.isArray(taskContainer?.result) || taskContainer.result.length === 0) {
      throw new DataForSeoTaskError(
        `DataForSEO task error: ${taskContainer?.status_message ?? "no result returned"} (status ${taskContainer?.status_code ?? "unknown"})`,
      );
    }
    const task = taskContainer.result[0];
    // A task that ran and found nothing returns `items: []` (or a null items
    // field) — that is a VALID EMPTY RESULT, not a provider failure. Anything
    // else in the items position is a malformed payload and fails closed.
    const rawItems = task?.items ?? [];
    if (!Array.isArray(rawItems)) {
      throw new SerpEvidenceInvalidError(
        `DataForSEO returned a malformed items payload for "${params.keyword}" (${typeof task?.items})`,
      );
    }
    const serpFeatures: string[] = Array.isArray(task?.item_types) ? task.item_types : [];
    const observedAt = normalizeSerpDatetime(task?.datetime) ?? taskContainer.time ?? "";

    const items: OrganicSerpItem[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== "object") {
        throw new SerpEvidenceInvalidError(
          `DataForSEO returned a malformed SERP item for "${params.keyword}"`,
        );
      }
      if (item.type !== "organic") continue;
      if (typeof item.url !== "string") {
        throw new SerpEvidenceInvalidError(
          `DataForSEO organic item for "${params.keyword}" is missing a URL`,
        );
      }
      const rank = item.rank_group ?? item.rank_absolute;
      if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 1) {
        throw new SerpEvidenceInvalidError(
          `DataForSEO organic item for "${params.keyword}" has no usable rank (${String(rank)})`,
        );
      }
      let domain: string;
      try {
        domain = new URL(item.url).hostname.replace("www.", "");
      } catch {
        throw new SerpEvidenceInvalidError(
          `DataForSEO organic item for "${params.keyword}" has an unparseable URL: ${item.url}`,
        );
      }
      items.push({
        rankAbsolute: item.rank_absolute,
        rankGroup: rank,
        url: item.url,
        domain,
        title: item.title || "",
        snippet: item.description || "",
      });
    }

    return {
      keyword: params.keyword,
      locationName,
      languageName,
      device,
      observedAt,
      serpFeatures,
      items,
    };
  }

  async getRankings(
    keyword: string,
    domain: string,
    location: string = "United States",
  ): Promise<{
    position: number | null;
    url: string | null;
    serpFeatures: string[];
    competitors: Array<{
      domain: string;
      position: number;
      url: string;
      title: string;
      snippet: string;
    }>;
  }> {
    const result = await this.request("/serp/google/organic/live/advanced", [
      {
        keyword,
        location_name: location,
        language_name: "English",
        device: "desktop",
        depth: 20,
      },
    ]);

    const items = result.tasks?.[0]?.result?.[0]?.items || [];
    const serpFeatures = result.tasks?.[0]?.result?.[0]?.item_types || [];

    let position: number | null = null;
    let url: string | null = null;
    const competitors: Array<{
      domain: string;
      position: number;
      url: string;
      title: string;
      snippet: string;
    }> = [];

    for (const item of items) {
      if (item.type !== "organic") continue;

      const itemDomain = new URL(item.url).hostname.replace("www.", "");

      if (itemDomain === domain.replace("www.", "")) {
        position = item.rank_absolute;
        url = item.url;
      } else {
        competitors.push({
          domain: itemDomain,
          position: item.rank_absolute,
          url: item.url,
          title: item.title || "",
          snippet: item.description || "",
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
    const result = await this.request("/backlinks/summary/live", [
      {
        target: domain,
        internal_list_limit: 0,
      },
    ]);

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
    const result = await this.request("/on_page/instant_pages", [
      {
        url,
        load_resources: false,
      },
    ]);

    const page = result.tasks?.[0]?.result?.[0]?.items?.[0] || {};
    return {
      wordCount: page.meta?.content?.plain_text_word_count || 0,
      headings:
        (page.meta?.htags?.h1?.length || 0) +
        (page.meta?.htags?.h2?.length || 0) +
        (page.meta?.htags?.h3?.length || 0),
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
  if (typeof datetime !== "string" || !datetime.trim()) return undefined;
  const parsed = new Date(datetime.replace(" ", "T").replace(" ", ""));
  return Number.isNaN(parsed.getTime()) ? datetime : parsed.toISOString();
}
