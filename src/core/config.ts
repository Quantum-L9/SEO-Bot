/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Configuration Loader
 * Validates all environment variables at startup via Zod schemas.
 * Fails fast with clear error messages if config is invalid.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // PostHog
  POSTHOG_API_URL: z.string().url(),
  POSTHOG_PERSONAL_API_KEY: z.string().min(1),

  // DataForSEO
  DATAFORSEO_LOGIN: z.string().min(1),
  DATAFORSEO_PASSWORD: z.string().min(1),
  // Per-request HTTP timeout for the DataForSEO client. The live SERP endpoint
  // (google/organic/live/advanced) routinely needs longer than 30s under load —
  // golden runs #35/#36 timed out consecutively at exactly 30s. Validated here
  // so a blank, non-numeric, or non-positive deployment value fails at startup
  // rather than reaching axios as NaN and failing every provider request.
  DATAFORSEO_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  // Google APIs
  PAGESPEED_API_KEY: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SEARCH_CONSOLE_SITE_URL: z.string().optional(),

  // LLM — @quantum-l9/llm-router (replaces old tiered model)
  OPENROUTER_API_KEY: z.string().min(1),
  PERPLEXITY_API_KEY: z.string().min(1),

  // Governed cross-agent memory (l9-graphiti-memory HTTP MCP)
  L9_MEMORY_MODE: z.enum(["disabled", "optional", "required"]).default("optional"),
  L9_MEMORY_URL: z.string().url().optional(),
  L9_MEMORY_TOKEN: z.string().min(1).optional(),
  L9_MEMORY_TOKEN_BUDGET: z.coerce.number().int().min(128).max(64000).default(1200),
  L9_MEMORY_MAX_RECORDS: z.coerce.number().int().min(1).max(200).default(40),

  // Cross-repo handoff: shared secret presented by Website-Bot as a Bearer
  // token to POST /api/clients/register. REQUIRED for that route — when unset,
  // registration fails closed (503) rather than accepting anonymous upserts.
  // Must match Website-Bot's SEO_BOT_API_KEY secret.
  SEO_BOT_API_KEY: z.string().optional(),

  // Operator API/dashboard auth. Shared secret required (Basic password or
  // Bearer token) to reach any operator route except /health and the
  // machine-authenticated /api/clients/register. When unset, the operator API
  // is locked (401) — fail closed. Set this to enable dashboard access.
  OPERATOR_API_KEY: z.string().optional(),

  // Comma-separated CORS allow-list for the operator API. When unset, CORS is
  // disabled (same-origin only) — the safe default for an operator-only surface.
  DASHBOARD_ALLOWED_ORIGINS: z.string().optional(),

  // Email Outreach
  SMTP_HOST: z.string().default("smtp.sendgrid.net"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default("apikey"),
  SMTP_PASSWORD: z.string().optional(),
  OUTREACH_FROM_EMAIL: z.string().email().optional(),
  OUTREACH_FROM_NAME: z.string().optional(),

  // Hunter.io
  HUNTER_API_KEY: z.string().optional(),

  // Citation Services
  BRIGHTLOCAL_API_KEY: z.string().optional(),

  // Bot Config
  BOT_PORT: z.coerce.number().default(3100),
  BOT_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BOT_TIMEZONE: z.string().default("America/New_York"),
  // Trust X-Forwarded-For. Set true when the API runs behind a reverse proxy /
  // tunnel (Caddy/nginx/Cloudflare) so request.ip — and the per-IP rate limiter
  // — reflect the real client IP rather than the proxy's. Default false (do not
  // trust XFF) to avoid IP spoofing when not behind a trusted proxy.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Notifications
  OPERATOR_EMAIL: z.string().email().optional(),
  OPERATOR_CC_EMAIL: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Budget — @quantum-l9/llm-router surge-aware model
  DEFAULT_CLIENT_MONTHLY_BUDGET: z.coerce.number().default(200.0),
  DEFAULT_CLIENT_WEEKLY_TARGET: z.coerce.number().default(50.0),
  DEFAULT_CLIENT_WEEKLY_CEILING: z.coerce.number().default(100.0),
  GLOBAL_MONTHLY_HARD_CEILING: z.coerce.number().default(2000.0),
  SURGE_THRESHOLD: z.coerce.number().default(0.6),
  // Optional hard daily LLM spend cap (USD). When set, execute() defers tasks
  // once the day's recorded spend reaches this value. Unset = no daily cap
  // (the router's weekly/monthly/global ceilings still apply).
  DAILY_SPEND_CAP: z.coerce.number().optional(),

  // Execution Policy
  AUTO_EXECUTE_THRESHOLD: z.enum(["low", "medium", "high"]).default("high"),
  REQUIRE_APPROVAL_ONLY_FOR: z.string().default("critical"),

  // Site Deployment Transport (C-01 / GAP-08) — only used when the
  // serp:execute-surpass-plans job is enabled. All optional so startup never
  // fails when the feature is off; validated here so typos surface clearly.
  // ─── Intelligence Control Loop ──────────────────────────────────────────────
  // The intelligence substrate is a closed-loop controller: it derives signals
  // from SQL, ranks opportunities, gates them against policy, and routes work
  // into the EXISTING scheduler jobs. It never mutates SEO state directly.
  //
  // Master switch. When false the intelligence jobs are never scheduled at all,
  // rather than scheduled and no-oping — an operator should see zero
  // intelligence jobs, not a stream of jobs that do nothing.
  INTELLIGENCE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Per-client ceiling on opportunities considered in one planning run. Bounds
  // both blast radius and LLM cost: the planner sees at most this many.
  INTELLIGENCE_MAX_OPPORTUNITIES_PER_CLIENT: z.coerce.number().int().positive().default(10),

  // Opportunities scoring below this are recorded but never planned or routed.
  // Scores are 0..100 (see opportunity-scorer for the scale of each factor), so
  // the default acts on roughly the top half.
  INTELLIGENCE_MIN_SCORE_TO_PLAN: z.coerce.number().min(0).default(50),

  // When false, even LOW-risk analysis jobs are proposed rather than enqueued.
  // This is the difference between "the loop suggests" and "the loop acts", and
  // is the flag to turn off first if routing ever misbehaves.
  INTELLIGENCE_AUTO_ROUTE_LOW_RISK: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Gates the LLM planner. With this false the loop is fully deterministic:
  // SQL signals, arithmetic scoring, and rules-based routing, with no model in
  // the path and no token spend.
  INTELLIGENCE_LLM_PLANNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Weekly cross-client benchmark. Off by default: it is the only intelligence
  // query that is not client-scoped, so it stays opt-in even though it returns
  // anonymized aggregates only.
  INTELLIGENCE_PORTFOLIO_BENCHMARK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Signals not re-observed within this many days stop feeding opportunities.
  INTELLIGENCE_SIGNAL_STALE_DAYS: z.coerce.number().int().positive().default(14),

  GITHUB_TOKEN: z.string().optional(),
  VERCEL_DEPLOY_HOOK: z.string().optional(),
  WEBSITE_BOT_REPO: z.string().optional(),
  SITE_SOURCE_BRANCH: z.string().default("main"),
  SITE_DEPLOY_DRY_RUN: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    console.error("═══ L9 SEO Bot - Configuration Error ═══");
    console.error("The following environment variables are missing or invalid:");
    console.error(errors.join("\n"));
    console.error("═══════════════════════════════════════════");
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): EnvConfig {
  if (!_config) return loadConfig();
  return _config;
}
