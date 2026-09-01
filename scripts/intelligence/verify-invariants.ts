/* L9_META
 * layer: script
 * role: intelligence_verification
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Post-run invariant check for the intelligence and reporting planes.
 *
 * The testing contract (§13) asks for a SQL pack to run after every integration
 * or staging cycle. Its example queries describe a schema that was planned and
 * not built — there is no `intelligence_action_links` table; the shipped design
 * links a decision to an opportunity, an experiment to a decision, and an
 * experiment to the existing `action_outcomes` row. So this pack asks the same
 * QUESTIONS of the schema that exists rather than transcribing queries against
 * one that does not.
 *
 * Every invariant is phrased so that ROWS MEAN A VIOLATION. There is no
 * "expected count" to eyeball and no threshold to argue with: the pack is green
 * when every query returns nothing. That framing is what makes it safe to run
 * unattended and to exit non-zero on.
 *
 * Read-only by construction — see `assertReadOnly`. This runs against staging
 * and production databases, and a verification tool that can write is a
 * verification tool that can be the incident.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/intelligence/verify-invariants.ts
 *   ... --json          machine-readable output
 *   ... --only=INTEL-03 run one invariant
 *
 * Exit codes: 0 clean · 1 at least one violation · 2 the pack could not run.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Client } from "pg";

export interface Invariant {
  /** Stable id, quoted in runbooks and incident notes. */
  readonly id: string;
  readonly title: string;
  /** What a violation would mean operationally — the reason the check exists. */
  readonly meaning: string;
  /** Rows returned ARE the violations. A clean database returns none. */
  readonly sql: string;
}

/**
 * How stale a `running` row has to be before it counts as abandoned. Longer than
 * any real cycle and shorter than the daily cadence, so a stuck run is caught on
 * the same day it stuck.
 */
const ABANDONED_RUN_HOURS = 6;

/**
 * The complete vocabulary of actions the plane may ever log.
 *
 * Kept as SQL literals rather than read from `PLAN_TEMPLATES` at runtime: the
 * pack has to be runnable against a database whose deployed code is a different
 * version from this checkout — that is the case it exists for. The unit test
 * pins this list against the templates so the two cannot drift silently.
 */
const PLANE_ACTIONS = [
  "faq_content_add",
  "schema_markup_injection",
  "meta_title_update",
  "page_speed_optimization",
  "outreach_email_send",
];

export const INVARIANTS: readonly Invariant[] = [
  {
    id: "INTEL-01",
    title: "No run is abandoned in `running`",
    meaning:
      "A run that never reached `completed` or `failed` means the process died mid-cycle. Its " +
      "opportunities exist without the decisions that would have acted on them, and the " +
      "dashboard shows the client as quiet rather than as broken.",
    sql: `
      SELECT id, client_id, run_type, started_at
      FROM intelligence_runs
      WHERE status = 'running'
        AND started_at < now() - interval '${ABANDONED_RUN_HOURS} hours'
      ORDER BY started_at
    `,
  },
  {
    id: "INTEL-02",
    title: "A failed run says why it failed",
    meaning:
      "`status = 'failed'` with no error text is an incident with its evidence discarded — the " +
      "one row that was supposed to explain the gap explains nothing.",
    sql: `
      SELECT id, client_id, run_type, started_at
      FROM intelligence_runs
      WHERE status = 'failed' AND (error IS NULL OR btrim(error) = '')
      ORDER BY started_at DESC
    `,
  },
  {
    id: "INTEL-03",
    title: "No duplicate LIVE opportunity for one fingerprint",
    meaning:
      "The fingerprint is an opportunity's identity. Two live rows sharing one means suppression " +
      "failed, and the same remedy will be proposed — and possibly executed — twice.",
    sql: `
      SELECT client_id, fingerprint, count(*) AS live_rows
      FROM intelligence_opportunities
      WHERE status IN ('open', 'actioned')
      GROUP BY client_id, fingerprint
      HAVING count(*) > 1
    `,
  },
  {
    id: "INTEL-04",
    title: "No auto-executed action outside the plane's vocabulary",
    meaning:
      "An action the taxonomy has never heard of falls through classifyAction's default and " +
      "acquires auto-execute rights. This is the query that catches a model, or a future caller, " +
      "talking its way past the approval gate by naming something new.",
    sql: `
      SELECT id, client_id, action, status, created_at
      FROM action_log
      WHERE module = 'intelligence'
        AND status = 'auto_executed'
        AND action NOT IN (${PLANE_ACTIONS.map((action) => `'${action}'`).join(", ")})
      ORDER BY created_at DESC
    `,
  },
  {
    id: "INTEL-05",
    title: "No CRITICAL action was ever auto-executed",
    meaning:
      "The approval boundary, checked against what was persisted rather than against the code " +
      "that was supposed to enforce it. This holds for every module, not only the plane.",
    sql: `
      SELECT id, client_id, module, action, created_at
      FROM action_log
      WHERE risk_level = 'critical' AND status = 'auto_executed'
      ORDER BY created_at DESC
    `,
  },
  {
    id: "INTEL-06",
    title: "The live-site write job never ran",
    meaning:
      "`serp:execute-surpass-plans` is excluded from TRIGGERABLE_JOBS and ships disabled. A " +
      "job_executions row for it means something reached it anyway — through a manual enqueue, " +
      "a widened allow-list, or a flipped `enabled` flag.",
    sql: `
      SELECT id, client_id, status, started_at
      FROM job_executions
      WHERE job_name = 'serp:execute-surpass-plans'
      ORDER BY started_at DESC
    `,
  },
  {
    id: "INTEL-07",
    title: "Only the synthesis job spends tokens",
    meaning:
      "The plane's reasoning is deterministic and must cost nothing. Any intelligence-module LLM " +
      "spend whose purpose is not plan synthesis means a reasoning path started reaching a model " +
      "— per client, per day, forever.",
    sql: `
      SELECT client_id, purpose, tier, sum(cost) AS cost, count(*) AS calls
      FROM llm_usage
      WHERE module = 'intelligence'
        AND purpose NOT ILIKE '%rank remedies%'
      GROUP BY client_id, purpose, tier
      ORDER BY sum(cost) DESC
    `,
  },
  {
    id: "INTEL-08",
    title: "No experiment measures an action that does not exist",
    meaning:
      "An experiment whose action_outcome_id points at nothing is a measurement window attached " +
      "to no action. It will produce a verdict, and that verdict will be attributed to the bot.",
    sql: `
      SELECT e.id, e.client_id, e.target_metric, e.created_at
      FROM intelligence_experiments e
      LEFT JOIN action_outcomes o ON o.id = e.action_outcome_id
      WHERE e.action_outcome_id IS NOT NULL AND o.id IS NULL
      ORDER BY e.created_at DESC
    `,
  },
  {
    id: "INTEL-09",
    title: "No experiment window is inverted or zero-length",
    meaning:
      "A baseline that starts after it ends, or a measurement window that overlaps the change " +
      "itself, produces a comparison that reads as a result and measures nothing.",
    sql: `
      SELECT id, client_id, baseline_start, baseline_end, measurement_start, measurement_end
      FROM intelligence_experiments
      WHERE baseline_start >= baseline_end
         OR measurement_start >= measurement_end
         OR measurement_start < baseline_end
      ORDER BY created_at DESC
    `,
  },
  {
    id: "INTEL-10",
    title: "No signal belongs to a different tenant than its run",
    meaning:
      "Every operational query is client-scoped. A signal whose client_id differs from its run's " +
      "is one tenant's data recorded under another's — the failure the scoping exists to prevent, " +
      "checked against the rows rather than against the queries.",
    sql: `
      SELECT s.id, s.client_id AS signal_client, r.client_id AS run_client
      FROM intelligence_signals s
      JOIN intelligence_runs r ON r.id = s.run_id
      WHERE r.client_id IS NOT NULL AND s.client_id <> r.client_id
      ORDER BY s.created_at DESC
    `,
  },
  {
    id: "INTEL-11",
    title: "A resolved opportunity has a measured improvement behind it",
    meaning:
      "Only a measured improvement closes an opportunity (C3). A `resolved` row with no improved " +
      "experiment means something closed it on other grounds, and the problem it described is " +
      "now invisible while still being real.",
    sql: `
      SELECT o.id, o.client_id, o.opportunity_type, o.updated_at
      FROM intelligence_opportunities o
      WHERE o.status = 'resolved'
        AND NOT EXISTS (
          SELECT 1
          FROM intelligence_decisions d
          JOIN intelligence_experiments e ON e.decision_id = d.id
          WHERE d.opportunity_id = o.id
            AND e.result ->> 'verdict' = 'improved'
        )
      ORDER BY o.updated_at DESC
    `,
  },
  {
    id: "REPORT-01",
    title: "No published cohort is below the k-anonymity floor",
    meaning:
      "The floor is a privacy decision, enforced in the migration at two levels — once on the " +
      "cohort and once per metric. This asks the published view whether the enforcement held.",
    sql: `
      SELECT industry, country, state, period, cohort_size
      FROM reporting.portfolio_benchmarks
      WHERE cohort_size < 5
      ORDER BY period DESC
    `,
  },
  {
    id: "REPORT-02",
    title: "No per-metric statistic is published for fewer clients than the floor",
    meaning:
      "The second level of the floor, and the one easy to omit: a cohort can hold five clients " +
      "while only two of them have vitals data, and publishing an LCP percentile over those two " +
      "describes two identifiable clients under a cohort label.",
    sql: `
      SELECT industry, country, state, period, position_clients, lcp_clients
      FROM reporting.portfolio_benchmarks
      WHERE (position_clients IS NOT NULL AND position_clients < 5)
         OR (lcp_clients IS NOT NULL AND lcp_clients < 5)
      ORDER BY period DESC
    `,
  },
  {
    id: "REPORT-03",
    title: "No reporting read is stuck in `started`",
    meaning:
      "The gateway writes the audit row BEFORE it executes and finalizes it after, so a row left " +
      "at `started` is a query that began and never reported back — a statement timeout, a " +
      "crashed worker, or a read that bypassed the finalize. Audit is fail-closed on the way in; " +
      "this is what checks the way out.",
    sql: `
      SELECT id, actor_type, query_name, created_at
      FROM reporting.query_audit_log
      WHERE status = 'started'
        AND created_at < now() - interval '1 hour'
      ORDER BY created_at DESC
    `,
  },
];

/**
 * Refuse anything that could write.
 *
 * Checked at runtime rather than trusted from review: this connects to
 * production. The check is deliberately crude and deliberately over-broad — a
 * false positive costs an edit to a query, a false negative costs a database.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO)\b/i;

export function assertReadOnly(invariant: Invariant): void {
  const withoutStrings = invariant.sql.replace(/'[^']*'/g, "''");
  if (WRITE_KEYWORDS.test(withoutStrings)) {
    throw new Error(`${invariant.id} contains a write keyword; the pack is read-only`);
  }
  if (withoutStrings.includes(";")) {
    throw new Error(`${invariant.id} contains a statement separator; one query per invariant`);
  }
}

export interface InvariantResult {
  readonly id: string;
  readonly title: string;
  readonly violations: number;
  readonly rows: Record<string, unknown>[];
  readonly error?: string;
}

/** Run every invariant. A query that ERRORS is a failure, never a pass. */
export async function runInvariants(
  query: (sql: string) => Promise<Record<string, unknown>[]>,
  invariants: readonly Invariant[] = INVARIANTS,
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const invariant of invariants) {
    assertReadOnly(invariant);
    try {
      const rows = await query(invariant.sql);
      results.push({
        id: invariant.id,
        title: invariant.title,
        violations: rows.length,
        // Bounded: a violated invariant can return a lot, and the report is for
        // a human deciding what to do next, not a data export.
        rows: rows.slice(0, 20),
      });
    } catch (error) {
      results.push({
        id: invariant.id,
        title: invariant.title,
        violations: 0,
        rows: [],
        // A relation that does not exist means the pack is checking a database
        // it does not understand. Reporting that as "no violations" would be the
        // most dangerous possible output.
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function formatReport(results: readonly InvariantResult[]): string {
  const lines: string[] = ["Intelligence plane — invariant verification", ""];
  for (const result of results) {
    if (result.error)
      lines.push(`  ERROR  ${result.id}  ${result.title}\n         ${result.error}`);
    else if (result.violations > 0)
      lines.push(`  FAIL   ${result.id}  ${result.title} — ${result.violations} row(s)`);
    else lines.push(`  ok     ${result.id}  ${result.title}`);
  }
  const failed = results.filter((result) => result.violations > 0 || result.error);
  lines.push("", failed.length === 0 ? "All invariants hold." : `${failed.length} need attention.`);
  return lines.join("\n");
}

/** True when anything at all is wrong — a violation OR a query that could not run. */
export function hasFindings(results: readonly InvariantResult[]): boolean {
  return results.some((result) => result.violations > 0 || result.error);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required.");
    process.exit(2);
  }

  const selected = only ? INVARIANTS.filter((invariant) => invariant.id === only) : INVARIANTS;
  if (selected.length === 0) {
    console.error(`No invariant matches --only=${only}`);
    process.exit(2);
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    // Belt and braces around assertReadOnly: even a query that slipped past the
    // keyword check cannot write through a read-only session.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '30s'");

    const results = await runInvariants(async (sql) => {
      const result = await client.query(sql);
      return result.rows as Record<string, unknown>[];
    }, selected);

    console.log(asJson ? JSON.stringify({ results }, null, 2) : formatReport(results));
    process.exit(hasFindings(results) ? 1 : 0);
  } catch (error) {
    console.error(`Verification could not run: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Only when executed directly, so the invariants can be imported by tests.
if (process.argv[1]?.endsWith("verify-invariants.ts")) {
  void main();
}
