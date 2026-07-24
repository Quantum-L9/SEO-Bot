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

import { z } from 'zod';
import * as dotenv from 'dotenv';

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

  // Google APIs
  PAGESPEED_API_KEY: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SEARCH_CONSOLE_SITE_URL: z.string().optional(),

  // LLM — @quantum-l9/llm-router (replaces old tiered model)
  OPENROUTER_API_KEY: z.string().min(1),
  PERPLEXITY_API_KEY: z.string().min(1),

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
  SMTP_HOST: z.string().default('smtp.sendgrid.net'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default('apikey'),
  SMTP_PASSWORD: z.string().optional(),
  OUTREACH_FROM_EMAIL: z.string().email().optional(),
  OUTREACH_FROM_NAME: z.string().optional(),

  // Hunter.io
  HUNTER_API_KEY: z.string().optional(),

  // Citation Services
  BRIGHTLOCAL_API_KEY: z.string().optional(),

  // Bot Config
  BOT_PORT: z.coerce.number().default(3100),
  BOT_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  BOT_TIMEZONE: z.string().default('America/New_York'),
  // Trust X-Forwarded-For. Set true when the API runs behind a reverse proxy /
  // tunnel (Caddy/nginx/Cloudflare) so request.ip — and the per-IP rate limiter
  // — reflect the real client IP rather than the proxy's. Default false (do not
  // trust XFF) to avoid IP spoofing when not behind a trusted proxy.
  TRUST_PROXY: z.string().optional().transform((v) => v === 'true' || v === '1'),

  // Notifications
  OPERATOR_EMAIL: z.string().email().optional(),
  OPERATOR_CC_EMAIL: z.string().email().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Budget — @quantum-l9/llm-router surge-aware model
  DEFAULT_CLIENT_MONTHLY_BUDGET: z.coerce.number().default(200.00),
  DEFAULT_CLIENT_WEEKLY_TARGET: z.coerce.number().default(50.00),
  DEFAULT_CLIENT_WEEKLY_CEILING: z.coerce.number().default(100.00),
  GLOBAL_MONTHLY_HARD_CEILING: z.coerce.number().default(2000.00),
  SURGE_THRESHOLD: z.coerce.number().default(0.6),
  // Optional hard daily LLM spend cap (USD). When set, execute() defers tasks
  // once the day's recorded spend reaches this value. Unset = no daily cap
  // (the router's weekly/monthly/global ceilings still apply).
  DAILY_SPEND_CAP: z.coerce.number().optional(),

  // Execution Policy
  AUTO_EXECUTE_THRESHOLD: z.enum(['low', 'medium', 'high']).default('high'),
  REQUIRE_APPROVAL_ONLY_FOR: z.string().default('critical'),

  // Site Deployment Transport (C-01 / GAP-08) — only used when the
  // serp:execute-surpass-plans job is enabled. All optional so startup never
  // fails when the feature is off; validated here so typos surface clearly.
  GITHUB_TOKEN: z.string().optional(),
  VERCEL_DEPLOY_HOOK: z.string().optional(),
  WEBSITE_BOT_REPO: z.string().optional(),
  SITE_SOURCE_BRANCH: z.string().default('main'),
  SITE_DEPLOY_DRY_RUN: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`
    );
    console.error('═══ L9 SEO Bot - Configuration Error ═══');
    console.error('The following environment variables are missing or invalid:');
    console.error(errors.join('\n'));
    console.error('═══════════════════════════════════════════');
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): EnvConfig {
  if (!_config) return loadConfig();
  return _config;
}
