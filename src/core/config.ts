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
// The rollout ladder's single definition. `mode.ts` is dependency-free, so this
// import cannot cycle — and keeping the list beside the rank logic that reads it
// is what stops the enum and the ladder drifting apart.
import { INTELLIGENCE_MODES } from "../intelligence/mode.js";

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

  // Reporting SQL plane (ADR-0015). The agent read surface is OPT-IN: when this
  // is unset, /api/reporting/* is reachable by the operator key only and no
  // agent audience exists. Set it to give IgorBot / n8n / LLM tooling access to
  // the masked, identity-free projections — never the operator key, which would
  // hand an agent client names, domains, and contact PII.
  REPORTING_AGENT_API_KEY: z.string().optional(),

  // Intelligence plane (ADR-0016). Opportunities scoring at or above this
  // threshold are eligible to become action proposals; everything below is
  // recorded and left for the next cycle. Raising it makes the bot more
  // conservative without disabling reasoning.
  INTELLIGENCE_MIN_OPPORTUNITY_SCORE: z.coerce.number().min(0).default(20),
  // Per-run ceiling on how many opportunities may be turned into proposals for
  // one client. Bounds blast radius when a client suddenly produces many signals.
  INTELLIGENCE_MAX_ACTIONS_PER_RUN: z.coerce.number().int().min(0).max(100).default(3),
  // Days a signal fingerprint stays suppressed after being observed, so the same
  // observation does not regenerate the same opportunity every cycle.
  INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  // Age at which an opportunity that has stopped recurring is marked `expired`
  // (ADR-0016 contract C3). MUST exceed INTELLIGENCE_SIGNAL_COOLDOWN_DAYS: inside
  // the cooldown a repeat observation is suppressed and writes no new opportunity
  // row, so a shorter window would read ordinary suppression as the problem
  // having gone away. `assertLifecycleConfig` enforces the relationship.
  INTELLIGENCE_OPPORTUNITY_EXPIRY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Intelligence plane contract C2. When false, the plane reasons entirely
  // deterministically and every proposal keeps the action its static template
  // chose. This is the only switch that makes the plane spend tokens of its own,
  // and turning it off must never stop the bot reasoning — availability of a
  // model is not allowed to be a dependency of the loop.
  // Matches TRUST_PROXY's shape, and for the same reason: `z.coerce.boolean()`
  // treats every non-empty string as true, so `=false` in an env file would
  // ENABLE the one feature here that spends money.
  INTELLIGENCE_LLM_PLANNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Per-sweep ceiling on proposals sent for model ranking. This is the plane's
  // only token-spending step; an unbounded sweep after an unusual day is the one
  // place a deterministic-by-design system could produce a surprising bill.
  INTELLIGENCE_SYNTHESIS_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  // Attribution windows: how long before/after an action is measured.
  INTELLIGENCE_BASELINE_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  INTELLIGENCE_MEASUREMENT_DAYS: z.coerce.number().int().min(1).max(180).default(28),

  // Rollout ladder for the intelligence plane (hardening contract C5). Installing
  // the plane and ENABLING it are two decisions, and this is the second one, so a
  // production cutover is staged rather than a deploy that turns everything on at
  // the moment the image starts.
  //
  // Defaults to `off`: a fresh install reasons about nothing until an operator
  // says otherwise. That is the conservative direction — the failure mode of the
  // wrong default here is "the bot did nothing", not "the bot acted on a database
  // it had never seen before".
  //
  // See src/intelligence/mode.ts for what each rung grants. `full` deliberately
  // does NOT grant outreach or site mutation; both need their own flag below.
  INTELLIGENCE_MODE: z.enum(INTELLIGENCE_MODES).default("off"),
  // Out-of-ladder capability: queueing the outreach follow-up job, which sends
  // mail to third parties. Irreversible, so it is never implied by a mode.
  //
  // Matches INTELLIGENCE_LLM_PLANNING_ENABLED's shape, and for the same reason:
  // `z.coerce.boolean()` treats every non-empty string as true, so
  // `INTELLIGENCE_ALLOW_OUTREACH_ROUTING=false` in an env file would ENABLE it.
  INTELLIGENCE_ALLOW_OUTREACH_ROUTING: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Out-of-ladder capability: queueing work that writes to a client's live site.
  // The live-write job stays off TRIGGERABLE_JOBS regardless (AGENTS §9); this
  // flag is the second lock, not a replacement for the first.
  INTELLIGENCE_ALLOW_SITE_MUTATION: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

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
  GITHUB_TOKEN: z.string().optional(),
  VERCEL_DEPLOY_HOOK: z.string().optional(),
  WEBSITE_BOT_REPO: z.string().optional(),
  SITE_SOURCE_BRANCH: z.string().default("main"),
  SITE_DEPLOY_DRY_RUN: z.string().optional(),
});

/**
 * The operator key and the reporting agent key must be DIFFERENT secrets.
 * Sharing one collapses the audience split: the agent surface would resolve to
 * the operator audience (checked first) and receive client names, domains, and
 * contact PII — exactly what the masked plane exists to prevent. Fail at
 * startup rather than leaking on the first request.
 */
const configSchema = envSchema.superRefine((value, ctx) => {
  if (
    value.OPERATOR_API_KEY &&
    value.REPORTING_AGENT_API_KEY &&
    value.OPERATOR_API_KEY === value.REPORTING_AGENT_API_KEY
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REPORTING_AGENT_API_KEY"],
      message:
        "must not equal OPERATOR_API_KEY — the reporting agent surface requires its own secret",
    });
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);

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
