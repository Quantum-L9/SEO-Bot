/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Operator Dashboard
 *
 * Server-rendered HTML dashboard (no frontend framework required).
 * One dashboard to rule them all — portfolio view + client drill-down.
 * Password-protected, operator-only access.
 *
 * Routes:
 *   GET /dashboard              → Portfolio overview (all clients)
 *   GET /dashboard/intelligence → What the bot concluded, and whether it worked
 *   GET /dashboard/:clientId    → Client drill-down
 *   GET /dashboard/approvals    → Pending approvals queue
 *   POST /dashboard/approve/:id → Approve an action
 *   POST /dashboard/reject/:id  → Reject an action
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import type { ReportingQueryRequest } from "../reporting/query-compiler.js";
import { executeReportingQuery } from "../reporting/query-gateway.js";
import { getRefreshStatus } from "../reporting/refresh.js";

const logger = createModuleLogger("dashboard");

/**
 * HTML-escape any interpolated value. DB/LLM-derived strings (client names,
 * keywords, action descriptions, LLM rationales/options) must never be placed
 * into the operator dashboard markup unescaped — a client registered with a
 * `<script>`/`<img onerror>` name would otherwise inject into the operator's
 * session. Numbers/enums pass through harmlessly.
 */
export function escapeHtml(value: unknown): string {
  let str: string;
  if (value == null) str = "";
  else if (typeof value === "object") str = JSON.stringify(value);
  else str = String(value);
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
const esc = escapeHtml;

// ─── Presentation helpers ─────────────────────────────────────────────────────
// Extracted from inline nested ternaries so each mapping is a single, testable
// statement (keeps template literals flat and readable).

function healthBadgeClass(rating: unknown): string {
  if (rating === "good") return "good";
  if (rating === "needs-improvement") return "warning";
  return "critical";
}

function riskBadgeClass(level: unknown): string {
  if (level === "low") return "good";
  if (level === "medium") return "warning";
  return "critical";
}

function rankDeltaColor(position: number | undefined, previous: number | undefined): string {
  if (!position || !previous) return "#94a3b8";
  if (position < previous) return "#6ee7b7";
  if (position > previous) return "#fca5a5";
  return "#94a3b8";
}

function rankDeltaText(position: number | undefined, previous: number | undefined): string {
  if (!position || !previous) return "—";
  if (position < previous) return `+${previous - position}`;
  if (position > previous) return `-${position - previous}`;
  return "=";
}

// ─── Intelligence panels (ADR-0016, contract C4) ──────────────────────────────
//
// Read through the reporting GATEWAY, never straight off the tables. The gateway
// audits before it executes, holds a read-only transaction, applies a statement
// timeout, and projects per audience. A dashboard that queried the tables
// directly would be a second, unaudited read path — and the audit log exists
// precisely so there is only one.

const DASHBOARD_ACTOR = {
  id: "dashboard",
  type: "human" as const,
  surface: "dashboard",
  audience: "operator" as const,
};

interface PanelResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Set when the panel could not be loaded. Rendered in place of the rows. */
  readonly error: string | null;
}

/**
 * Run one named query for a panel.
 *
 * A failure is captured, not thrown. These views arrive with migration 0005, and
 * a dashboard that 500s wholesale because one view is missing takes the working
 * panels down with it — including the approvals queue an operator may be trying
 * to reach. Each panel says what went wrong in its own box instead.
 */
async function panel(request: ReportingQueryRequest): Promise<PanelResult> {
  try {
    const result = await executeReportingQuery(request, DASHBOARD_ACTOR);
    return { rows: result.rows, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ view: request.view, err: message }, "Intelligence panel query failed");
    return { rows: [], error: message };
  }
}

/**
 * Age of the materialized snapshots, worst first.
 *
 * Surfaced inline rather than on a separate page: an operator reading a stale
 * number without knowing it is stale is worse served than one shown no number.
 */
async function snapshotAges(): Promise<{ rows: RefreshAgeRow[]; error: string | null }> {
  try {
    const status = await getRefreshStatus();
    const rows = status
      .map((row) => ({
        viewName: row.viewName,
        ageMinutes: Math.round(row.ageSeconds / 60),
        status: row.status,
      }))
      .sort((a, b) => b.ageMinutes - a.ageMinutes);
    return { rows, error: null };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

interface RefreshAgeRow {
  viewName: string;
  ageMinutes: number;
  status: string;
}

// ─── Dashboard Registration ───────────────────────────────────────────────────

export async function registerDashboard(app: FastifyInstance): Promise<void> {
  // ─── Portfolio Overview ───────────────────────────────────────────────────

  app.get("/dashboard", async (_request, reply) => {
    const db = getDb();

    const clients = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(schema.clients.name);

    // Get pending approval count
    const pendingResult = await db
      .select({
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.actionLog)
      .where(eq(schema.actionLog.status, "pending_approval"));

    const pendingCount = pendingResult[0]?.count || 0;

    // Get today's global spend
    const today = new Date().toISOString().split("T")[0];
    const spendResult = await db
      .select({
        total: sql<number>`COALESCE(SUM(cost), 0)`,
      })
      .from(schema.llmUsage)
      .where(gte(schema.llmUsage.timestamp, new Date(today)));

    const todaySpend = spendResult[0]?.total || 0;

    // Get per-client health scores (simplified: based on latest vitals rating)
    const clientSummaries = await Promise.all(
      clients.map(async (client) => {
        const [latestVital] = await db
          .select()
          .from(schema.webVitals)
          .where(eq(schema.webVitals.clientId, client.id))
          .orderBy(desc(schema.webVitals.measuredAt))
          .limit(1);

        const [latestRanking] = await db
          .select({
            avgPos: sql<number>`AVG(position)`,
          })
          .from(schema.serpRankings)
          .where(eq(schema.serpRankings.clientId, client.id));

        const clientPending = await db
          .select({
            count: sql<number>`COUNT(*)`,
          })
          .from(schema.actionLog)
          .where(
            and(
              eq(schema.actionLog.clientId, client.id),
              eq(schema.actionLog.status, "pending_approval"),
            ),
          );

        return {
          ...client,
          healthRating: latestVital?.rating || "unknown",
          avgPosition: latestRanking?.avgPos ? Math.round(latestRanking.avgPos * 10) / 10 : null,
          pendingApprovals: clientPending[0]?.count || 0,
        };
      }),
    );

    const html = renderPortfolio(clientSummaries, pendingCount, todaySpend);
    reply.type("text/html").send(html);
  });

  // ─── Intelligence: what the bot concluded, and whether it worked ──────────
  //
  // Declared BEFORE /dashboard/:clientId. Fastify's radix router prefers a
  // static segment over a parameter, but stating the order here means the page
  // does not depend on that preference holding for a future router change —
  // "intelligence" resolving as a client id would 404 with no clue why.

  app.get("/dashboard/intelligence", async (_request, reply) => {
    // Sequential, not Promise.all: each gateway query holds a connection for the
    // length of its statement timeout, and four at once on an operator page
    // refresh is a self-inflicted connection spike on the box running the bot.
    const opportunities = await panel({
      view: "intelligence_opportunities_live",
      orderBy: "score_desc",
      limit: 20,
    });
    const decisions = await panel({
      view: "intelligence_decisions_recent",
      filters: { days: 7 },
      orderBy: "created_at_desc",
      limit: 20,
    });
    const pending = await panel({
      view: "intelligence_experiments_pending",
      orderBy: "soonest_first",
      limit: 20,
    });
    const outcomes = await panel({
      view: "intelligence_outcomes_measured",
      orderBy: "measured_at_desc",
      limit: 20,
    });
    const freshness = await snapshotAges();

    reply
      .type("text/html")
      .send(renderIntelligence({ opportunities, decisions, pending, outcomes, freshness }));
  });

  // ─── Client Drill-Down ────────────────────────────────────────────────────

  app.get<{ Params: { clientId: string } }>("/dashboard/:clientId", async (request, reply) => {
    const db = getDb();
    const { clientId } = request.params;

    const [client] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) {
      reply.status(404).send("Client not found");
      return;
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 86400000);

    // Rankings
    const rankings = await db
      .select()
      .from(schema.serpRankings)
      .where(
        and(
          eq(schema.serpRankings.clientId, clientId),
          gte(schema.serpRankings.checkedAt, oneWeekAgo),
        ),
      )
      .orderBy(desc(schema.serpRankings.checkedAt))
      .limit(20);

    // Actions taken
    const actions = await db
      .select()
      .from(schema.actionLog)
      .where(
        and(eq(schema.actionLog.clientId, clientId), gte(schema.actionLog.createdAt, oneWeekAgo)),
      )
      .orderBy(desc(schema.actionLog.createdAt))
      .limit(20);

    // Engagement
    const engagement = await db
      .select()
      .from(schema.pageEngagement)
      .where(eq(schema.pageEngagement.clientId, clientId))
      .orderBy(desc(schema.pageEngagement.totalPageviews))
      .limit(10);

    const html = renderClientDetail(client, rankings, actions, engagement);
    reply.type("text/html").send(html);
  });

  // ─── Pending Approvals ────────────────────────────────────────────────────

  app.get("/dashboard/approvals", async (_request, reply) => {
    const db = getDb();

    const pending = await db
      .select()
      .from(schema.actionLog)
      .where(eq(schema.actionLog.status, "pending_approval"))
      .orderBy(desc(schema.actionLog.createdAt));

    // Enrich with client names
    const enriched = await Promise.all(
      pending.map(async (action) => {
        const [client] = await db
          .select({ name: schema.clients.name, domain: schema.clients.domain })
          .from(schema.clients)
          .where(eq(schema.clients.id, action.clientId))
          .limit(1);
        return {
          ...action,
          clientName: client?.name || "Unknown",
          clientDomain: client?.domain || "",
        };
      }),
    );

    const html = renderApprovals(enriched);
    reply.type("text/html").send(html);
  });

  // ─── Approve Action ───────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { option?: string } }>(
    "/dashboard/approve/:id",
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;
      const { option } = request.body ?? {};

      await db
        .update(schema.actionLog)
        .set({
          status: "approved",
          approvedBy: "operator-dashboard",
          approvedAt: new Date(),
          selectedOption: option || null,
        })
        .where(eq(schema.actionLog.id, id));

      logger.info({ actionId: id, selectedOption: option }, "Action approved via dashboard");
      reply.redirect("/dashboard/approvals");
    },
  );

  // ─── Reject Action ────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/dashboard/reject/:id",
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;
      const { reason } = request.body ?? {};

      await db
        .update(schema.actionLog)
        .set({
          status: "rejected",
          rejectionReason: reason || "Rejected by operator",
        })
        .where(eq(schema.actionLog.id, id));

      logger.info({ actionId: id, reason }, "Action rejected via dashboard");
      reply.redirect("/dashboard/approvals");
    },
  );
}

// ─── HTML Renderers ───────────────────────────────────────────────────────────

function baseLayout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | L9 SEO Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #334155; }
    .header h1 { font-size: 24px; color: #f8fafc; }
    .nav { display: flex; gap: 16px; }
    .nav a { color: #94a3b8; text-decoration: none; padding: 8px 16px; border-radius: 6px; transition: all 0.2s; }
    .nav a:hover, .nav a.active { color: #f8fafc; background: #1e293b; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card h3 { font-size: 16px; color: #f8fafc; margin-bottom: 8px; }
    .card .metric { font-size: 32px; font-weight: bold; color: #38bdf8; }
    .card .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge-good { background: #064e3b; color: #6ee7b7; }
    .badge-warning { background: #78350f; color: #fbbf24; }
    .badge-critical { background: #7f1d1d; color: #fca5a5; }
    .badge-pending { background: #1e3a5f; color: #93c5fd; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    td { color: #e2e8f0; }
    .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-approve { background: #065f46; color: #6ee7b7; }
    .btn-approve:hover { background: #047857; }
    .btn-reject { background: #7f1d1d; color: #fca5a5; }
    .btn-reject:hover { background: #991b1b; }
    .btn-view { background: #1e3a5f; color: #93c5fd; }
    .btn-view:hover { background: #1e40af; }
    .stat-row { display: flex; gap: 24px; margin-bottom: 24px; }
    .stat { text-align: center; }
    .stat .value { font-size: 28px; font-weight: bold; }
    .stat .label { font-size: 12px; color: #94a3b8; }
    .approval-card { background: #1e293b; border: 1px solid #fbbf24; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .options-list { list-style: none; padding: 0; margin: 12px 0; }
    .options-list li { padding: 8px 12px; margin: 4px 0; border-radius: 6px; background: #0f172a; }
    .options-list li.recommended { border: 1px solid #38bdf8; background: #0c4a6e; }
    form { display: inline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>L9 SEO Bot</h1>
      <div class="nav">
        <a href="/dashboard">Portfolio</a>
        <a href="/dashboard/intelligence">Intelligence</a>
        <a href="/dashboard/approvals">Approvals</a>
        <a href="/health">Health</a>
      </div>
    </div>
    ${content}
  </div>
</body>
</html>`;
}

interface DashboardClientDetailRow {
  id: string;
  name: string;
  domain: string;
  industry: string;
  city?: string | null;
  state?: string | null;
}

interface DashboardClientRow {
  id: string;
  name: string;
  domain: string;
  industry: string;
  city?: string | null;
  state?: string | null;
  avgPosition?: number | null;
  healthRating: string;
  pendingApprovals: number;
}

interface DashboardRankingRow {
  keyword: string;
  position: number | null;
  previousPosition: number | null;
}

interface DashboardActionRow {
  action: string;
  description: string;
  riskLevel: string;
  status: string;
  triggeredBy: string;
}

interface DashboardApprovalRow {
  id: string;
  action: string;
  clientDomain: string;
  module: string;
  riskLevel: string;
  reversible?: boolean;
  description: string;
  rationale: string;
  triggeredBy: string;
  aiRecommendation?: string | null;
  aiConfidence?: number | null;
  options?: unknown;
}

interface DashboardOptionRow {
  id?: string | number;
  label?: string;
  description?: string;
  recommended?: boolean;
  confidence?: number;
}

function renderPortfolio(
  clients: DashboardClientRow[],
  pendingCount: number,
  todaySpend: number,
): string {
  const statsHtml = `
    <div class="grid">
      <div class="card">
        <div class="label">Active Clients</div>
        <div class="metric">${clients.length}</div>
      </div>
      <div class="card">
        <div class="label">Pending Approvals</div>
        <div class="metric" style="color: ${pendingCount > 0 ? "#fbbf24" : "#6ee7b7"}">${pendingCount}</div>
      </div>
      <div class="card">
        <div class="label">Today's Token Spend</div>
        <div class="metric">$${todaySpend.toFixed(2)}</div>
      </div>
    </div>
  `;

  const clientRows = clients
    .map(
      (c) => `
    <tr>
      <td><a href="/dashboard/${encodeURIComponent(c.id)}" class="btn-view" style="text-decoration: none;">${esc(c.name)}</a></td>
      <td>${esc(c.domain)}</td>
      <td>${esc(c.industry)}</td>
      <td>${c.avgPosition ? `#${c.avgPosition}` : "—"}</td>
      <td><span class="badge badge-${healthBadgeClass(c.healthRating)}">${esc(c.healthRating)}</span></td>
      <td>${c.pendingApprovals > 0 ? `<span class="badge badge-pending">${esc(c.pendingApprovals)} pending</span>` : "—"}</td>
    </tr>
  `,
    )
    .join("");

  const content = `
    ${statsHtml}
    <h2 style="margin-bottom: 16px; color: #f8fafc;">Client Portfolio</h2>
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th>Domain</th>
          <th>Industry</th>
          <th>Avg Position</th>
          <th>Health</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${clientRows}</tbody>
    </table>
  `;

  return baseLayout("Portfolio", content);
}

function renderClientDetail(
  client: DashboardClientDetailRow,
  rankings: DashboardRankingRow[],
  actions: DashboardActionRow[],
  _engagement: unknown[],
): string {
  const rankingRows = rankings
    .slice(0, 10)
    .map(
      (r) => `
    <tr>
      <td>${esc(r.keyword)}</td>
      <td>${r.position || "—"}</td>
      <td>${r.previousPosition || "—"}</td>
      <td style="color: ${rankDeltaColor(r.position ?? undefined, r.previousPosition ?? undefined)}">
        ${rankDeltaText(r.position ?? undefined, r.previousPosition ?? undefined)}
      </td>
    </tr>
  `,
    )
    .join("");

  const actionRows = actions
    .slice(0, 10)
    .map(
      (a) => `
    <tr>
      <td>${esc(a.action)}</td>
      <td>${esc(a.description)}</td>
      <td><span class="badge badge-${riskBadgeClass(a.riskLevel)}">${esc(a.riskLevel)}</span></td>
      <td><span class="badge badge-${a.status === "auto_executed" ? "good" : "pending"}">${esc(a.status)}</span></td>
      <td style="font-style: italic; color: #94a3b8; font-size: 12px;">${esc(a.triggeredBy)}</td>
    </tr>
  `,
    )
    .join("");

  const content = `
    <h2 style="margin-bottom: 8px; color: #f8fafc;">${esc(client.name)}</h2>
    <p style="color: #94a3b8; margin-bottom: 24px;">${esc(client.domain)} | ${esc(client.industry)} | ${esc(client.city || "")}, ${esc(client.state || "")}</p>

    <h3 style="margin-bottom: 12px; color: #f8fafc;">Rankings (Last 7 Days)</h3>
    <table>
      <thead><tr><th>Keyword</th><th>Position</th><th>Previous</th><th>Change</th></tr></thead>
      <tbody>${rankingRows || '<tr><td colspan="4" style="color: #94a3b8;">No ranking data yet</td></tr>'}</tbody>
    </table>

    <h3 style="margin-bottom: 12px; color: #f8fafc;">Actions (Last 7 Days)</h3>
    <table>
      <thead><tr><th>Action</th><th>Description</th><th>Risk</th><th>Status</th><th>Triggered By</th></tr></thead>
      <tbody>${actionRows || '<tr><td colspan="5" style="color: #94a3b8;">No actions yet</td></tr>'}</tbody>
    </table>
  `;

  return baseLayout(client.name, content);
}

interface IntelligencePageData {
  opportunities: PanelResult;
  decisions: PanelResult;
  pending: PanelResult;
  outcomes: PanelResult;
  freshness: { rows: RefreshAgeRow[]; error: string | null };
}

function verdictBadgeClass(verdict: unknown): string {
  if (verdict === "improved") return "good";
  if (verdict === "declined") return "critical";
  return "warning";
}

function decisionBadgeClass(decision: unknown): string {
  if (decision === "propose_action") return "good";
  if (decision === "escalate_to_operator") return "critical";
  return "pending";
}

/** Fixed-precision, or an em dash. `null` must not render as "null". */
function num(value: unknown, digits = 2): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return "—";
  return parsed.toFixed(digits);
}

/**
 * A panel's body, or the reason it has none.
 *
 * `columns` is the colspan for the empty/error row, so a failed panel does not
 * collapse the table it sits in.
 */
function panelBody(result: PanelResult, columns: number, rows: string): string {
  if (result.error) {
    return `<tr><td colspan="${columns}" style="color: #fca5a5;">Unavailable: ${esc(result.error)}</td></tr>`;
  }
  return rows || `<tr><td colspan="${columns}" style="color: #94a3b8;">Nothing yet.</td></tr>`;
}

/**
 * The operator's answer to "what did the bot do this week, and did it work?"
 *
 * EVERY interpolated value goes through `esc`. `title`, `description`,
 * `rationale`, `hypothesis` and `learnings` are model-authored free text that
 * quotes evidence the bot read — a client registered with a `<script>` name, or
 * a keyword containing one, reaches this page through them.
 */
function renderIntelligence(data: IntelligencePageData): string {
  const freshnessHtml = data.freshness.error
    ? `<p style="color: #fca5a5;">Snapshot freshness unavailable: ${esc(data.freshness.error)}</p>`
    : data.freshness.rows.length === 0
      ? `<p style="color: #94a3b8;">No materialized snapshot has been refreshed yet.</p>`
      : `<p style="color: #94a3b8; font-size: 13px;">Snapshot age: ${data.freshness.rows
          .map(
            (row) =>
              `<span style="color: ${row.status === "ok" && row.ageMinutes < 720 ? "#94a3b8" : "#fbbf24"}">` +
              `${esc(row.viewName.replace("reporting.", ""))} ${esc(row.ageMinutes)}m</span>`,
          )
          .join(" · ")}</p>`;

  const opportunityRows = data.opportunities.rows
    .map(
      (row) => `
    <tr>
      <td>${esc(row.client_name)}</td>
      <td>${esc(row.title)}</td>
      <td>${esc(row.target_url ?? row.target_keyword ?? "—")}</td>
      <td>${num(row.score)}</td>
      <td><span class="badge badge-${row.status === "actioned" ? "pending" : "warning"}">${esc(row.status)}</span></td>
    </tr>`,
    )
    .join("");

  const decisionRows = data.decisions.rows
    .map(
      (row) => `
    <tr>
      <td>${esc(row.client_name)}</td>
      <td><span class="badge badge-${decisionBadgeClass(row.decision)}">${esc(row.decision)}</span></td>
      <td>${esc(row.opportunity_title ?? row.decision_type)}</td>
      <td style="color: #94a3b8; font-size: 13px;">${esc(row.rationale)}</td>
      <td>${esc(row.created_at)}</td>
    </tr>`,
    )
    .join("");

  const pendingRows = data.pending.rows
    .map(
      (row) => `
    <tr>
      <td>${esc(row.client_name)}</td>
      <td>${esc(row.target_metric)}</td>
      <td>${esc(row.entity_id)}</td>
      <td style="color: #94a3b8; font-size: 13px;">${esc(row.hypothesis)}</td>
      <td>${esc(row.days_remaining)}d</td>
    </tr>`,
    )
    .join("");

  const outcomeRows = data.outcomes.rows
    .map(
      (row) => `
    <tr>
      <td>${esc(row.client_name)}</td>
      <td><span class="badge badge-${verdictBadgeClass(row.verdict)}">${esc(row.verdict ?? row.status)}</span></td>
      <td>${esc(row.target_metric)}</td>
      <td>${num(row.baseline)} → ${num(row.measured)}</td>
      <td style="color: #94a3b8; font-size: 13px;">${esc(row.learnings)}</td>
    </tr>`,
    )
    .join("");

  const content = `
    <h2 style="margin-bottom: 4px; color: #f8fafc;">Intelligence</h2>
    ${freshnessHtml}

    <h3 style="margin: 24px 0 12px; color: #f8fafc;">Open work, highest score first</h3>
    <table>
      <thead><tr><th>Client</th><th>Opportunity</th><th>Target</th><th>Score</th><th>Status</th></tr></thead>
      <tbody>${panelBody(data.opportunities, 5, opportunityRows)}</tbody>
    </table>

    <h3 style="margin: 24px 0 12px; color: #f8fafc;">Decisions, last 7 days</h3>
    <table>
      <thead><tr><th>Client</th><th>Decision</th><th>About</th><th>Rationale</th><th>When</th></tr></thead>
      <tbody>${panelBody(data.decisions, 5, decisionRows)}</tbody>
    </table>

    <h3 style="margin: 24px 0 12px; color: #f8fafc;">Awaiting measurement</h3>
    <table>
      <thead><tr><th>Client</th><th>Metric</th><th>Entity</th><th>Hypothesis</th><th>Remaining</th></tr></thead>
      <tbody>${panelBody(data.pending, 5, pendingRows)}</tbody>
    </table>

    <h3 style="margin: 24px 0 12px; color: #f8fafc;">Did it work?</h3>
    <table>
      <thead><tr><th>Client</th><th>Verdict</th><th>Metric</th><th>Before → After</th><th>Learning</th></tr></thead>
      <tbody>${panelBody(data.outcomes, 5, outcomeRows)}</tbody>
    </table>
  `;

  return baseLayout("Intelligence", content);
}

function renderApprovals(pending: DashboardApprovalRow[]): string {
  if (pending.length === 0) {
    const content = `
      <h2 style="margin-bottom: 16px; color: #f8fafc;">Pending Approvals</h2>
      <div class="card" style="text-align: center; padding: 40px;">
        <p style="color: #6ee7b7; font-size: 18px;">All clear — no pending approvals.</p>
      </div>
    `;
    return baseLayout("Approvals", content);
  }

  const approvalCards = pending
    .map((a) => {
      let options: DashboardOptionRow[] = [];
      try {
        const parsed = typeof a.options === "string" ? JSON.parse(a.options) : a.options;
        if (Array.isArray(parsed)) options = parsed;
      } catch {
        options = [];
      }
      const optionsHtml =
        options.length > 0
          ? `
      <ul class="options-list">
        ${options
          .map(
            (o: DashboardOptionRow) => `
          <li class="${o.recommended ? "recommended" : ""}">
            <strong>${esc(String(o.id ?? "").toUpperCase())})</strong> ${esc(o.label)} — ${esc(o.description)}
            ${o.recommended ? '<span class="badge badge-good" style="margin-left: 8px;">AI Recommended</span>' : ""}
            <span style="float: right; color: #94a3b8;">${((Number(o.confidence) || 0) * 100).toFixed(0)}% confidence</span>
          </li>
        `,
          )
          .join("")}
      </ul>
    `
          : "";

      return `
      <div class="approval-card">
        <div style="display: flex; justify-content: space-between; align-items: start;">
          <div>
            <h3 style="color: #fbbf24;">${esc(a.action)}</h3>
            <p style="color: #94a3b8; font-size: 12px;">${esc(a.clientDomain)} | ${esc(a.module)} | ${esc(a.riskLevel)} risk${a.reversible ? "" : " | IRREVERSIBLE"}</p>
          </div>
          <span class="badge badge-${a.riskLevel === "medium" ? "warning" : "critical"}">${esc(a.riskLevel)}</span>
        </div>
        <p style="margin: 12px 0;">${esc(a.description)}</p>
        <p style="margin: 8px 0; color: #94a3b8;"><strong>Rationale:</strong> ${esc(a.rationale)}</p>
        <p style="margin: 8px 0; color: #94a3b8;"><strong>Triggered by:</strong> ${esc(a.triggeredBy)}</p>
        ${a.aiRecommendation ? `<p style="margin: 8px 0; color: #38bdf8;"><strong>AI Recommendation:</strong> ${esc(a.aiRecommendation)} (${((Number(a.aiConfidence) || 0) * 100).toFixed(0)}% confidence)</p>` : ""}
        ${optionsHtml}
        <div style="margin-top: 16px; display: flex; gap: 8px;">
          ${options
            .map(
              (o: DashboardOptionRow) => `
            <form method="POST" action="/dashboard/approve/${encodeURIComponent(a.id)}">
              <input type="hidden" name="option" value="${esc(o.id)}">
              <button type="submit" class="btn ${o.recommended ? "btn-approve" : "btn-view"}">
                Approve ${esc(String(o.id ?? "").toUpperCase())}${o.recommended ? " (Recommended)" : ""}
              </button>
            </form>
          `,
            )
            .join("")}
          <form method="POST" action="/dashboard/reject/${encodeURIComponent(a.id)}">
            <button type="submit" class="btn btn-reject">Reject</button>
          </form>
        </div>
      </div>
    `;
    })
    .join("");

  const content = `
    <h2 style="margin-bottom: 16px; color: #f8fafc;">Pending Approvals (${pending.length})</h2>
    ${approvalCards}
  `;

  return baseLayout("Approvals", content);
}
