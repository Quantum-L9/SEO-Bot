/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Evidence Pack Builder (ADR-0016)
 *
 * The LLM never queries the database. It receives a compact, redacted pack the
 * bot assembled from evidence it already holds, plus an explicit list of the
 * actions it may and may not propose.
 *
 * That inversion is the whole point. A model with a database socket writes its
 * own joins, sees whatever the columns happen to contain, and has to be trusted
 * not to act outside scope. A model with an evidence pack sees exactly what was
 * put in it, and `forbidden_actions` is a fact about the pack rather than an
 * instruction the model may reinterpret.
 *
 * Redaction is asserted, not assumed: `assertPackIsRedacted` walks the finished
 * pack and throws on any forbidden key or on any value that looks like a client
 * domain or an email address.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { ScoredOpportunity } from "./types.js";

/** Keys that must never appear anywhere in a pack, at any depth. */
export const FORBIDDEN_PACK_KEYS: ReadonlySet<string> = new Set([
  "posthog_api_key",
  "posthogapikey",
  "posthog_project_id",
  "posthogprojectid",
  "api_key",
  "apikey",
  "password",
  "token",
  "secret",
  "authorization",
  "contact_email",
  "contactemail",
  "contact_name",
  "contactname",
  "client_name",
  "clientname",
  "domain",
  "config",
]);

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

export interface EvidencePackClient {
  /** Industry and market only — never name, domain, or credentials. */
  readonly industry: string;
  readonly market: string | null;
}

export interface EvidencePack {
  readonly client: EvidencePackClient;
  readonly opportunity: {
    readonly type: string;
    readonly target_path: string | null;
    readonly target_keyword: string | null;
    readonly score: number;
    readonly urgency: number;
    readonly confidence: number;
  };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly allowed_actions: readonly string[];
  readonly forbidden_actions: readonly string[];
}

/**
 * Actions the intelligence plane may ever propose, by opportunity type.
 *
 * Every entry is a key in the execution policy's action taxonomy, so a proposal
 * built from one of these inherits a real risk classification instead of falling
 * through to the unknown-action default.
 */
export const ALLOWED_ACTIONS_BY_OPPORTUNITY: Readonly<Record<string, readonly string[]>> = {
  keyword_drop_plus_page_experience: [
    "faq_content_add",
    "schema_markup_injection",
    "internal_link_add",
    "page_speed_optimization",
  ],
  serp_and_answer_engine_loss: [
    "faq_content_add",
    "schema_markup_injection",
    "content_rewrite",
    "heading_optimization",
  ],
  keyword_recovery: ["meta_title_update", "meta_description_update", "internal_link_add"],
  page_experience_repair: [
    "page_speed_optimization",
    "css_performance_fix",
    "heading_optimization",
  ],
  performance_regression: ["page_speed_optimization", "css_performance_fix"],
  answer_engine_gap: ["faq_content_add", "schema_markup_injection", "faq_content_update"],
  link_outreach_batch: ["outreach_email_send", "guest_post_pitch"],
  budget_review: [],
  pipeline_repair: [],
};

/**
 * Never proposable from this plane, on any opportunity, regardless of score.
 *
 * These are the CRITICAL-tier and live-deployment paths. The intelligence plane
 * does not mutate a site; it proposes into the existing approval flow, and a
 * structural change is the operator's decision to make.
 */
export const FORBIDDEN_ACTIONS: readonly string[] = [
  "site_redesign",
  "seo_strategy_overhaul",
  "domain_migration",
  "domain_change",
  "bulk_page_delete",
  "bulk_redirect_change",
  "hosting_migration",
  "deploy_without_approval",
  "edit_client_config",
];

export function allowedActionsFor(opportunityType: string): readonly string[] {
  return ALLOWED_ACTIONS_BY_OPPORTUNITY[opportunityType] ?? [];
}

export function buildEvidencePack(
  opportunity: ScoredOpportunity,
  client: EvidencePackClient,
): EvidencePack {
  const pack: EvidencePack = {
    client: { industry: client.industry, market: client.market },
    opportunity: {
      type: opportunity.opportunityType,
      target_path: opportunity.targetUrl,
      target_keyword: opportunity.targetKeyword,
      score: opportunity.score,
      urgency: opportunity.urgency,
      confidence: opportunity.confidence,
    },
    evidence: redactEvidence(opportunity.evidence) as Record<string, unknown>,
    allowed_actions: allowedActionsFor(opportunity.opportunityType),
    forbidden_actions: FORBIDDEN_ACTIONS,
  };

  assertPackIsRedacted(pack);
  return pack;
}

/**
 * Strip forbidden keys at every depth, and normalize any absolute URL down to a
 * path so a client domain cannot ride along inside an otherwise-innocent value.
 */
export function redactEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEvidence);

  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PACK_KEYS.has(key.toLowerCase())) continue;
      output[key] = redactEvidence(entry);
    }
    return output;
  }

  if (typeof value === "string") {
    if (EMAIL_PATTERN.test(value)) return "[redacted:email]";
    // https://client.example/pricing → /pricing
    const withoutOrigin = value.replace(/^https?:\/\/[^/\s]+/i, "");
    return withoutOrigin === "" ? "/" : withoutOrigin;
  }

  return value;
}

/**
 * Prove the finished pack carries no identity or credential.
 *
 * A throw here is a bug in redaction, not a caller error — which is exactly why
 * it throws rather than quietly dropping the offending field: silently sending a
 * "mostly redacted" pack is the failure this guard exists to make impossible.
 */
export function assertPackIsRedacted(pack: unknown, path = "pack"): void {
  if (Array.isArray(pack)) {
    for (const [index, entry] of pack.entries()) {
      assertPackIsRedacted(entry, `${path}[${index}]`);
    }
    return;
  }

  if (pack !== null && typeof pack === "object") {
    for (const [key, value] of Object.entries(pack as Record<string, unknown>)) {
      if (FORBIDDEN_PACK_KEYS.has(key.toLowerCase())) {
        throw new Error(`Evidence pack leaked forbidden key "${key}" at ${path}`);
      }
      assertPackIsRedacted(value, `${path}.${key}`);
    }
    return;
  }

  if (typeof pack === "string") {
    if (EMAIL_PATTERN.test(pack)) {
      throw new Error(`Evidence pack leaked an email address at ${path}`);
    }
    if (/^https?:\/\//i.test(pack)) {
      throw new Error(`Evidence pack leaked an absolute URL (and therefore a domain) at ${path}`);
    }
  }
}
