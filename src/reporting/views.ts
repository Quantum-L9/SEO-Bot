/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Reporting View Registry (ADR-0015)
 *
 * The named-query allow-list. This registry — not an LLM, not a caller — decides
 * which relations are reachable, which columns each audience may see, which
 * filters exist, how rows may be ordered, and how many rows come back.
 *
 * Two audiences:
 *   operator — human via dashboard/psql. May see client name and domain.
 *   agent    — IgorBot / n8n / LLM tooling. NEVER sees client name, domain,
 *              contact email, or any credential. Views without a safe
 *              projection simply have no agent entry and are unreachable.
 *
 * Every identifier here is repository-authored and closed-set; no caller input
 * ever reaches a column name, relation, or ORDER BY fragment. Values are bound
 * parameters. `assertRegistryIdentifiersAreSafe()` re-proves that at import.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

export type ReportingAudience = "operator" | "agent";

/** Comparison operators the compiler may emit. Closed set. */
export type FilterOperator = "=" | ">=" | "<=" | ">" | "<";

export type FilterSpec =
  | { kind: "uuid"; column: string; operator: "="; description: string }
  | {
      kind: "int";
      column: string;
      operator: FilterOperator;
      min: number;
      max: number;
      description: string;
    }
  | {
      kind: "number";
      column: string;
      operator: FilterOperator;
      min: number;
      max: number;
      description: string;
    }
  | { kind: "enum"; column: string; operator: "="; values: readonly string[]; description: string }
  | {
      kind: "enumIn";
      column: string;
      values: readonly string[];
      maxSelected: number;
      description: string;
    }
  | { kind: "recentDays"; column: string; min: number; max: number; description: string }
  /**
   * Bounded free text, for an open-set dimension an enum cannot enumerate —
   * `industry` and `state` are whatever client registration recorded. The value
   * is a bound parameter either way, so this is not an injection boundary; the
   * charset and length cap keep unbounded caller strings out of the audit row
   * and make a typo a rejection rather than an empty result set.
   */
  | { kind: "token"; column: string; operator: "="; maxLength: number; description: string };

export interface ReportingViewDefinition {
  /** Stable public name callers pass as `view`. */
  readonly name: string;
  /** Fully-qualified, already-quoted relation. Repository-authored only. */
  readonly relation: string;
  readonly description: string;
  /**
   * Explicit per-audience column projection. Explicit — not `SELECT *` — so a
   * future column added to the view cannot silently widen what an agent sees.
   * A missing audience key means that audience cannot reach this view at all.
   */
  readonly projections: Partial<Record<ReportingAudience, readonly string[]>>;
  readonly filters: Readonly<Record<string, FilterSpec>>;
  /** alias → ORDER BY fragment. Closed set; callers pass the alias only. */
  readonly orderBy: Readonly<Record<string, string>>;
  readonly defaultOrderBy: string;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

const CLIENT_FILTER: FilterSpec = {
  kind: "uuid",
  column: "client_id",
  operator: "=",
  description: "Restrict to a single tenant.",
};

/**
 * Minimum number of distinct clients a cohort must contain before any statistic
 * about it may be published (ADR-0015, contract C1).
 *
 * The number that actually governs disclosure lives in migration 0004, as a
 * literal repeated at every guard — a function or a setting could be changed at
 * runtime, whereas lowering the floor in a view definition is a migration
 * someone has to review. This constant exists so the TypeScript side can state
 * the same number, and `plane-contract.test.ts` reads the migration's literals
 * back and refuses any that fall below it.
 *
 * Five, not two or three: with two clients in a cohort each derives the other's
 * numbers exactly from the aggregate and its own, and with three or four,
 * closely enough to be a disclosure.
 */
export const BENCHMARK_K_ANONYMITY_FLOOR = 5;

/**
 * Cohort dimensions plus the distribution. No client id, name, or domain — the
 * whole point of the plane is that this can be read without one.
 */
const PORTFOLIO_BENCHMARK_COLUMNS: readonly string[] = [
  "industry",
  "country",
  "state",
  "period",
  "cohort_size",
  "position_clients",
  "position_p25",
  "position_p50",
  "position_p75",
  "lcp_clients",
  "lcp_p25",
  "lcp_p50",
  "lcp_p75",
  "exit_rate_clients",
  "exit_rate_p25",
  "exit_rate_p50",
  "exit_rate_p75",
  "citation_rate_clients",
  "citation_rate_p25",
  "citation_rate_p50",
  "citation_rate_p75",
];

export const REPORTING_VIEWS: readonly ReportingViewDefinition[] = [
  {
    name: "clients_agent",
    relation: '"reporting"."clients_agent"',
    description: "Masked client dimension: hashed reference, industry and market only.",
    projections: {
      operator: ["client_id", "client_ref", "industry", "state", "country", "active", "created_at"],
      agent: ["client_ref", "industry", "state", "country", "created_at"],
    },
    filters: { client_id: CLIENT_FILTER },
    orderBy: { created_at_desc: "created_at DESC", industry_asc: "industry ASC" },
    defaultOrderBy: "created_at_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "clients_safe",
    relation: '"reporting"."clients_safe"',
    description: "Active clients with name and domain. Never carries PostHog credentials.",
    projections: {
      operator: [
        "client_id",
        "name",
        "domain",
        "industry",
        "city",
        "state",
        "country",
        "active",
        "created_at",
        "updated_at",
      ],
    },
    filters: { client_id: CLIENT_FILTER },
    orderBy: { name_asc: "name ASC", created_at_desc: "created_at DESC" },
    defaultOrderBy: "name_asc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "latest_serp_rankings",
    relation: '"reporting"."latest_serp_rankings"',
    description: "Most recent ranking per client × keyword × device, with movement.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "keyword",
        "device",
        "position",
        "previous_position",
        "position_delta",
        "movement",
        "url",
        "checked_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      device: {
        kind: "enum",
        column: "device",
        operator: "=",
        values: ["desktop", "mobile"],
        description: "Device the SERP was sampled on.",
      },
      movement: {
        kind: "enumIn",
        column: "movement",
        values: ["improved", "declined", "flat", "unknown"],
        maxSelected: 4,
        description: "Direction of change versus the previous sample.",
      },
      max_position: {
        kind: "int",
        column: "position",
        operator: "<=",
        min: 1,
        max: 200,
        description: "Only keywords ranking at or above this position.",
      },
      days: {
        kind: "recentDays",
        column: "checked_at",
        min: 1,
        max: 365,
        description: "Only rows checked within this many days.",
      },
    },
    orderBy: {
      position_asc: "position ASC NULLS LAST",
      delta_desc: "position_delta DESC NULLS LAST",
      checked_at_desc: "checked_at DESC",
    },
    defaultOrderBy: "position_asc",
    defaultLimit: 50,
    maxLimit: 500,
  },
  {
    name: "keyword_drops_7d",
    relation: '"reporting"."keyword_drops_7d"',
    description: "Keywords that lost five or more positions in the last seven days.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "keyword",
        "device",
        "previous_position",
        "current_position",
        "position_delta",
        "url",
        "checked_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      device: {
        kind: "enum",
        column: "device",
        operator: "=",
        values: ["desktop", "mobile"],
        description: "Device the SERP was sampled on.",
      },
      min_delta: {
        kind: "int",
        column: "position_delta",
        operator: ">=",
        min: 5,
        max: 200,
        description: "Minimum positions lost.",
      },
    },
    orderBy: {
      delta_desc: "position_delta DESC, checked_at DESC",
      checked_at_desc: "checked_at DESC",
    },
    defaultOrderBy: "delta_desc",
    defaultLimit: 50,
    maxLimit: 250,
  },
  {
    name: "weekly_keyword_movements",
    relation: '"reporting"."mv_weekly_keyword_movements"',
    description: "Materialized weekly open/close/best/worst position per keyword.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "keyword",
        "device",
        "week_start",
        "samples",
        "best_position",
        "worst_position",
        "avg_position",
        "week_open_position",
        "week_close_position",
        "week_delta",
      ],
      agent: [
        "keyword",
        "device",
        "week_start",
        "samples",
        "best_position",
        "worst_position",
        "avg_position",
        "week_delta",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      device: {
        kind: "enum",
        column: "device",
        operator: "=",
        values: ["desktop", "mobile"],
        description: "Device the SERP was sampled on.",
      },
      min_delta: {
        kind: "int",
        column: "week_delta",
        operator: ">=",
        min: -200,
        max: 200,
        description: "Minimum weekly position delta (positive = lost ground).",
      },
    },
    orderBy: {
      week_desc: "week_start DESC, week_delta DESC NULLS LAST",
      delta_desc: "week_delta DESC NULLS LAST",
    },
    defaultOrderBy: "week_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "page_experience_risks",
    relation: '"reporting"."page_experience_risks"',
    description: "Pages where engagement and Core Web Vitals are both poor.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "page_path",
        "period",
        "exit_rate",
        "bounce_rate",
        "avg_time_on_page",
        "avg_scroll_depth",
        "unique_visitors",
        "total_pageviews",
        "device",
        "source",
        "lcp",
        "inp",
        "cls",
        "rating",
        "risk_level",
        "measured_at",
        "computed_at",
      ],
      agent: [
        "page_path",
        "period",
        "exit_rate",
        "bounce_rate",
        "avg_scroll_depth",
        "total_pageviews",
        "device",
        "lcp",
        "inp",
        "cls",
        "risk_level",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      risk_level: {
        kind: "enumIn",
        column: "risk_level",
        values: ["critical", "high", "medium", "low"],
        maxSelected: 4,
        description: "Composite engagement × vitals risk band.",
      },
      device: {
        kind: "enum",
        column: "device",
        operator: "=",
        values: ["desktop", "mobile"],
        description: "Device the vitals sample came from.",
      },
      min_pageviews: {
        kind: "int",
        column: "total_pageviews",
        operator: ">=",
        min: 0,
        max: 10_000_000,
        description: "Ignore low-traffic pages below this pageview count.",
      },
    },
    orderBy: {
      pageviews_desc: "total_pageviews DESC NULLS LAST",
      lcp_desc: "lcp DESC NULLS LAST",
      exit_rate_desc: "exit_rate DESC NULLS LAST",
    },
    defaultOrderBy: "pageviews_desc",
    defaultLimit: 50,
    maxLimit: 250,
  },
  {
    name: "aeo_citation_rate_monthly",
    relation: '"reporting"."mv_aeo_citation_rate_monthly"',
    description: "Materialized answer-engine citation rate per client × platform × month.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "month",
        "platform",
        "queries_checked",
        "cited_count",
        "citation_rate_pct",
        "competitor_cited_count",
      ],
      agent: [
        "month",
        "platform",
        "queries_checked",
        "cited_count",
        "citation_rate_pct",
        "competitor_cited_count",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      platform: {
        kind: "enumIn",
        column: "platform",
        values: ["perplexity", "chatgpt", "claude", "gemini", "copilot"],
        maxSelected: 5,
        description: "Answer engine sampled.",
      },
      max_citation_rate: {
        kind: "number",
        column: "citation_rate_pct",
        operator: "<=",
        min: 0,
        max: 100,
        description: "Only months at or below this citation rate.",
      },
    },
    orderBy: {
      month_desc: "month DESC, citation_rate_pct ASC",
      rate_asc: "citation_rate_pct ASC NULLS LAST",
    },
    defaultOrderBy: "month_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "llm_spend_monthly",
    relation: '"reporting"."mv_llm_spend_monthly"',
    description: "Materialized LLM spend per client × month × module × tier.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "month",
        "module",
        "tier",
        "input_tokens",
        "output_tokens",
        "cost_usd",
      ],
      agent: ["month", "module", "tier", "input_tokens", "output_tokens", "cost_usd"],
    },
    filters: {
      client_id: CLIENT_FILTER,
      min_cost: {
        kind: "number",
        column: "cost_usd",
        operator: ">=",
        min: 0,
        max: 1_000_000,
        description: "Only rows at or above this monthly cost.",
      },
    },
    orderBy: { month_cost_desc: "month DESC, cost_usd DESC", cost_desc: "cost_usd DESC" },
    defaultOrderBy: "month_cost_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "job_failures_recent",
    relation: '"reporting"."job_failures_recent"',
    description: "Jobs that failed in the last 48 hours, including global (untenanted) jobs.",
    projections: {
      operator: [
        "id",
        "job_name",
        "client_id",
        "client_name",
        "domain",
        "status",
        "started_at",
        "completed_at",
        "duration_ms",
        "error",
      ],
      agent: ["job_name", "status", "started_at", "completed_at", "duration_ms"],
    },
    filters: {
      client_id: CLIENT_FILTER,
      status: {
        kind: "enumIn",
        column: "status",
        values: ["failed", "error"],
        maxSelected: 2,
        description: "Failure status recorded by the scheduler.",
      },
    },
    orderBy: { started_at_desc: "started_at DESC", job_name_asc: "job_name ASC, started_at DESC" },
    defaultOrderBy: "started_at_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "pending_approvals",
    relation: '"reporting"."pending_approvals"',
    description: "CRITICAL actions waiting on an operator decision, highest risk first.",
    projections: {
      operator: [
        "id",
        "client_id",
        "client_name",
        "domain",
        "module",
        "action",
        "description",
        "rationale",
        "risk_level",
        "reversible",
        "status",
        "ai_recommendation",
        "ai_confidence",
        "estimated_impact",
        "created_at",
        "expires_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      risk_level: {
        kind: "enumIn",
        column: "risk_level",
        values: ["critical", "high", "medium", "low"],
        maxSelected: 4,
        description: "Risk classification from the execution policy.",
      },
    },
    orderBy: {
      risk_then_age: "risk_rank ASC, created_at ASC",
      created_at_asc: "created_at ASC",
    },
    defaultOrderBy: "risk_then_age",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "portfolio_benchmarks",
    relation: '"reporting"."mv_portfolio_benchmarks"',
    description:
      "Cross-client cohort statistics by industry × geography × month. Suppressed below the " +
      "k-anonymity floor, at both cohort and per-metric level. Carries no client identity.",
    projections: {
      operator: PORTFOLIO_BENCHMARK_COLUMNS,
      // Identical to the operator projection, deliberately: a cohort statistic
      // that cleared the floor is not client data, and there is nothing here for
      // an agent projection to have to strip.
      agent: PORTFOLIO_BENCHMARK_COLUMNS,
    },
    filters: {
      industry: {
        kind: "token",
        column: "industry",
        operator: "=",
        maxLength: 80,
        description: "Cohort industry, lower-cased ('unknown' where the client has none).",
      },
      state: {
        kind: "token",
        column: "state",
        operator: "=",
        maxLength: 80,
        description: "Cohort state or region, lower-cased ('unknown' where absent).",
      },
      country: {
        kind: "token",
        column: "country",
        operator: "=",
        maxLength: 80,
        description: "Cohort country, lower-cased ('unknown' where absent).",
      },
      days: {
        kind: "recentDays",
        column: "period",
        min: 1,
        max: 1095,
        description: "Only cohort periods starting within this many days.",
      },
      min_cohort_size: {
        kind: "int",
        column: "cohort_size",
        operator: ">=",
        min: BENCHMARK_K_ANONYMITY_FLOOR,
        max: 10_000,
        // The minimum is the floor itself: a caller asking for smaller cohorts
        // is asking for suppressed ones, and the answer is a rejection rather
        // than an empty result that reads like "no such cohort".
        description: `Only cohorts of at least this many clients (never below ${BENCHMARK_K_ANONYMITY_FLOOR}).`,
      },
    },
    orderBy: {
      period_desc: "period DESC, industry ASC",
      cohort_size_desc: "cohort_size DESC, period DESC",
      industry_asc: "industry ASC, period DESC",
    },
    defaultOrderBy: "period_desc",
    defaultLimit: 100,
    maxLimit: 500,
  },
  {
    name: "portfolio_cohort_coverage",
    relation: '"reporting"."mv_portfolio_cohort_coverage"',
    description:
      "Which cohorts exist and which cleared the anonymity floor. Answers why a benchmark came " +
      "back empty. Size is published only for cohorts above the floor.",
    projections: {
      operator: ["industry", "country", "state", "period", "meets_anonymity_floor", "cohort_size"],
      agent: ["industry", "country", "state", "period", "meets_anonymity_floor", "cohort_size"],
    },
    filters: {
      industry: {
        kind: "token",
        column: "industry",
        operator: "=",
        maxLength: 80,
        description: "Cohort industry, lower-cased.",
      },
      days: {
        kind: "recentDays",
        column: "period",
        min: 1,
        max: 1095,
        description: "Only cohort periods starting within this many days.",
      },
    },
    orderBy: {
      period_desc: "period DESC, industry ASC",
      industry_asc: "industry ASC, period DESC",
    },
    defaultOrderBy: "period_desc",
    defaultLimit: 200,
    maxLimit: 1000,
  },
  {
    name: "intelligence_opportunities_live",
    relation: '"reporting"."intelligence_opportunities_live"',
    description:
      "Open and actioned opportunities, highest score first. The bot's current work list.",
    projections: {
      operator: [
        "opportunity_id",
        "client_id",
        "client_name",
        "domain",
        "opportunity_type",
        "title",
        "description",
        "target_url",
        "target_keyword",
        "score",
        "urgency",
        "confidence",
        "status",
        "created_at",
        "updated_at",
      ],
      // `title` and `description` are composed from the scorer's own templates
      // and the signal evidence, so they carry no identity — but `target_url`
      // does, and it stays out.
      agent: [
        "opportunity_type",
        "target_keyword",
        "score",
        "urgency",
        "confidence",
        "status",
        "created_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      status: {
        kind: "enumIn",
        column: "status",
        values: ["open", "actioned"],
        maxSelected: 2,
        description: "Lifecycle status. Resolved and expired work is not on this view.",
      },
      min_score: {
        kind: "number",
        column: "score",
        operator: ">=",
        min: 0,
        max: 100_000,
        description: "Only opportunities at or above this score.",
      },
    },
    orderBy: {
      score_desc: "score DESC, created_at DESC",
      created_at_desc: "created_at DESC",
    },
    defaultOrderBy: "score_desc",
    defaultLimit: 25,
    maxLimit: 250,
  },
  {
    name: "intelligence_decisions_recent",
    relation: '"reporting"."intelligence_decisions_recent"',
    description:
      "What the bot decided in the last 30 days and why. Rationale is model-authored free text.",
    projections: {
      operator: [
        "decision_id",
        "client_id",
        "client_name",
        "domain",
        "decision_type",
        "decision",
        "rationale",
        "requires_approval",
        "action_log_id",
        "opportunity_title",
        "opportunity_status",
        "blockers",
        "opportunity_score",
        "created_at",
      ],
      agent: [
        "decision_type",
        "decision",
        "opportunity_status",
        "blockers",
        "opportunity_score",
        "created_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      decision: {
        kind: "enumIn",
        column: "decision",
        values: [
          "propose_action",
          "defer_budget",
          "suppress_duplicate",
          "escalate_to_operator",
          "run_diagnostic",
          "no_action",
        ],
        maxSelected: 6,
        description: "The policy engine's verdict.",
      },
      days: {
        kind: "recentDays",
        column: "created_at",
        min: 1,
        max: 30,
        description: "Only decisions taken within this many days.",
      },
    },
    orderBy: {
      created_at_desc: "created_at DESC",
      score_desc: "opportunity_score DESC NULLS LAST, created_at DESC",
    },
    defaultOrderBy: "created_at_desc",
    defaultLimit: 25,
    maxLimit: 250,
  },
  {
    name: "intelligence_experiments_pending",
    relation: '"reporting"."intelligence_experiments_pending"',
    description: "Attribution windows still open, with days remaining before they can be judged.",
    projections: {
      operator: [
        "experiment_id",
        "client_id",
        "client_name",
        "domain",
        "hypothesis",
        "target_metric",
        "entity_type",
        "entity_id",
        "measurement_start",
        "measurement_end",
        "days_remaining",
        "status",
        "created_at",
      ],
      // `entity_id` is a keyword, page path, or platform — a page path is a
      // client's own URL structure, so it stays operator-only.
      agent: [
        "target_metric",
        "entity_type",
        "measurement_start",
        "measurement_end",
        "days_remaining",
        "status",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      metric: {
        kind: "enum",
        column: "target_metric",
        operator: "=",
        values: ["serp_position", "page_exit_rate", "aeo_citation_rate"],
        description: "Metric the experiment measures.",
      },
    },
    orderBy: {
      soonest_first: "measurement_end ASC",
      created_at_desc: "created_at DESC",
    },
    defaultOrderBy: "soonest_first",
    defaultLimit: 25,
    maxLimit: 250,
  },
  {
    name: "intelligence_outcomes_measured",
    relation: '"reporting"."intelligence_outcomes_measured"',
    description:
      "Did it work? Measured experiments with their verdict and the learning the memory " +
      "promoter reads. Learnings are model-authored free text.",
    projections: {
      operator: [
        "experiment_id",
        "client_id",
        "client_name",
        "domain",
        "target_metric",
        "entity_id",
        "status",
        "verdict",
        "baseline",
        "measured",
        "delta",
        "module",
        "action",
        "success",
        "learnings",
        "executed_at",
        "measured_at",
      ],
      agent: [
        "target_metric",
        "status",
        "verdict",
        "baseline",
        "measured",
        "delta",
        "module",
        "action",
        "success",
        "executed_at",
        "measured_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      verdict: {
        kind: "enumIn",
        column: "verdict",
        values: ["improved", "declined", "unchanged", "inconclusive"],
        maxSelected: 4,
        description: "How the experiment resolved.",
      },
      metric: {
        kind: "enum",
        column: "target_metric",
        operator: "=",
        values: ["serp_position", "page_exit_rate", "aeo_citation_rate"],
        description: "Metric the experiment measured.",
      },
    },
    orderBy: {
      measured_at_desc: "measured_at DESC NULLS LAST, executed_at DESC",
      executed_at_desc: "executed_at DESC",
    },
    defaultOrderBy: "measured_at_desc",
    defaultLimit: 25,
    maxLimit: 250,
  },
  {
    name: "link_prospects_uncontacted",
    relation: '"reporting"."link_prospects_uncontacted"',
    description: "Discovered link prospects not yet contacted. Operator-only: carries contact PII.",
    projections: {
      operator: [
        "client_id",
        "client_name",
        "domain",
        "target_url",
        "contact_email",
        "domain_rating",
        "relevance_score",
        "tactic",
        "status",
        "created_at",
      ],
    },
    filters: {
      client_id: CLIENT_FILTER,
      min_domain_rating: {
        kind: "int",
        column: "domain_rating",
        operator: ">=",
        min: 0,
        max: 100,
        description: "Minimum referring-domain rating.",
      },
    },
    orderBy: {
      dr_desc: "domain_rating DESC NULLS LAST, relevance_score DESC NULLS LAST",
      created_at_desc: "created_at DESC",
    },
    defaultOrderBy: "dr_desc",
    defaultLimit: 50,
    maxLimit: 250,
  },
] as const;

const VIEW_INDEX: ReadonlyMap<string, ReportingViewDefinition> = new Map(
  REPORTING_VIEWS.map((view) => [view.name, view]),
);

export function getReportingView(name: string): ReportingViewDefinition | undefined {
  return VIEW_INDEX.get(name);
}

/** Views an audience may reach, with their filter/order contracts. */
export function listReportingViews(audience: ReportingAudience): ReportingViewDefinition[] {
  return REPORTING_VIEWS.filter((view) => view.projections[audience] !== undefined);
}

// ─── Defensive identifier validation ─────────────────────────────────────────
//
// Nothing in this registry comes from a caller, so injection is already
// impossible by construction. These assertions exist so a future hand-edit that
// pastes an expression into a column list fails loudly at import rather than
// reaching the SQL compiler.

const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/;
const SAFE_RELATION = /^"[a-z_][a-z0-9_]*"\."[a-z_][a-z0-9_]*"$/;
const SAFE_ORDER_FRAGMENT = /^[a-z_][a-z0-9_]*(?: (?:ASC|DESC))?(?: NULLS (?:FIRST|LAST))?$/;

function assertOrderFragment(viewName: string, alias: string, fragment: string): void {
  for (const term of fragment.split(",")) {
    if (!SAFE_ORDER_FRAGMENT.test(term.trim())) {
      throw new Error(
        `Reporting registry: unsafe ORDER BY fragment on ${viewName}.${alias}: "${fragment}"`,
      );
    }
  }
}

export function assertRegistryIdentifiersAreSafe(
  views: readonly ReportingViewDefinition[] = REPORTING_VIEWS,
): void {
  const seen = new Set<string>();
  for (const view of views) {
    if (seen.has(view.name)) throw new Error(`Reporting registry: duplicate view "${view.name}"`);
    seen.add(view.name);

    if (!SAFE_RELATION.test(view.relation)) {
      throw new Error(`Reporting registry: unsafe relation on ${view.name}: ${view.relation}`);
    }

    const operatorColumns = view.projections.operator;
    if (!operatorColumns || operatorColumns.length === 0) {
      throw new Error(`Reporting registry: ${view.name} has no operator projection`);
    }

    for (const [audience, columns] of Object.entries(view.projections)) {
      for (const column of columns ?? []) {
        if (!SAFE_COLUMN.test(column)) {
          throw new Error(
            `Reporting registry: unsafe column on ${view.name}.${audience}: "${column}"`,
          );
        }
      }
    }

    // An agent projection must be a subset of the operator projection, and must
    // never carry client identity or contact PII.
    const agentColumns = view.projections.agent;
    if (agentColumns) {
      const operatorSet = new Set(operatorColumns);
      for (const column of agentColumns) {
        if (!operatorSet.has(column)) {
          throw new Error(
            `Reporting registry: ${view.name} agent column "${column}" is not in the operator projection`,
          );
        }
        if (AGENT_FORBIDDEN_COLUMNS.has(column)) {
          throw new Error(
            `Reporting registry: ${view.name} exposes identity/PII column "${column}" to agents`,
          );
        }
      }
    }

    for (const [filterName, spec] of Object.entries(view.filters)) {
      if (!SAFE_COLUMN.test(spec.column)) {
        throw new Error(
          `Reporting registry: unsafe filter column on ${view.name}.${filterName}: "${spec.column}"`,
        );
      }
    }

    for (const [alias, fragment] of Object.entries(view.orderBy)) {
      assertOrderFragment(view.name, alias, fragment);
    }

    if (!view.orderBy[view.defaultOrderBy]) {
      throw new Error(
        `Reporting registry: ${view.name} defaultOrderBy "${view.defaultOrderBy}" is not a declared order alias`,
      );
    }
    if (view.defaultLimit > view.maxLimit || view.defaultLimit < 1) {
      throw new Error(`Reporting registry: ${view.name} has an invalid default/max limit pair`);
    }
  }
}

/**
 * Columns an agent audience may never receive, on any view. `client_name`,
 * `domain`, and `contact_email` deanonymize the masked plane; `posthog_*` are
 * credentials that must not exist in `reporting` at all.
 */
export const AGENT_FORBIDDEN_COLUMNS: ReadonlySet<string> = new Set([
  "client_name",
  "name",
  "domain",
  // Model-authored free text that quotes the evidence it was reasoning over,
  // including target URLs and keywords. Redacting it per-value is not something
  // a column projection can do, so no agent projection carries it.
  "rationale",
  "learnings",
  "hypothesis",
  "description",
  "title",
  "opportunity_title",
  "entity_id",
  "target_url",
  "contact_email",
  "contact_name",
  "posthog_api_key",
  "posthog_project_id",
  "config",
  "url",
  "cited_url",
  "target_url",
  "error",
]);

assertRegistryIdentifiersAreSafe();
