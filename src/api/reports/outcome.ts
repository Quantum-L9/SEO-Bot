/* L9_META
 * layer: api
 * role: client_outcome_report_api
 * status: active
 * version: 1.0.0
 */

/**
 * GET /api/reports/clients/:clientId/outcome         — live report for a period
 *       ?from=<ISO>&to=<ISO>   default: the 7 days ending now (max 92 days)
 *       ?format=markdown       text/markdown instead of JSON {report, markdown}
 * GET /api/reports/clients/:clientId/outcome/latest  — latest weekly snapshot
 *
 * Operator surface: authenticated by the global OPERATOR_API_KEY hook
 * (src/api/security.ts). Read-only.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { createModuleLogger } from "../../core/logger.js";
import {
  buildOutcomeReport,
  type OutcomeReport,
  renderOutcomeReportMarkdown,
} from "../../reporting/outcome-report.js";
import {
  loadLatestOutcomeSnapshot,
  loadOutcomeReportInput,
} from "../../reporting/outcome-report-data.js";

const logger = createModuleLogger("api:reports");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 92;

export interface OutcomeReportRouteDeps {
  loadInput?: typeof loadOutcomeReportInput;
  loadLatest?: typeof loadLatestOutcomeSnapshot;
  now?: () => Date;
}

interface OutcomeQuery {
  from?: string;
  to?: string;
  format?: string;
}

function parseDate(value: string | undefined): Date | null | undefined {
  if (value === undefined || value === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function send(
  reply: FastifyReply,
  format: string | undefined,
  report: OutcomeReport,
  markdown: string,
  extra: Record<string, unknown> = {},
) {
  if (format === "markdown") {
    return reply.type("text/markdown; charset=utf-8").send(markdown);
  }
  return reply.send({ report, markdown, ...extra });
}

export async function registerOutcomeReportRoutes(
  app: FastifyInstance,
  deps: OutcomeReportRouteDeps = {},
): Promise<void> {
  const loadInput = deps.loadInput ?? loadOutcomeReportInput;
  const loadLatest = deps.loadLatest ?? loadLatestOutcomeSnapshot;
  const now = deps.now ?? (() => new Date());

  app.get<{ Params: { clientId: string }; Querystring: OutcomeQuery }>(
    "/api/reports/clients/:clientId/outcome",
    async (request, reply) => {
      const { clientId } = request.params;
      if (!UUID.test(clientId)) return reply.status(400).send({ error: "clientId must be a uuid" });
      const { format } = request.query;
      if (format !== undefined && format !== "json" && format !== "markdown")
        return reply.status(400).send({ error: "format must be json or markdown" });

      const at = now();
      const to = parseDate(request.query.to);
      const from = parseDate(request.query.from);
      if (to === null || from === null)
        return reply.status(400).send({ error: "from/to must be ISO-8601 timestamps" });
      const periodTo = to ?? at;
      const periodFrom = from ?? new Date(periodTo.getTime() - 7 * DAY_MS);
      if (periodFrom >= periodTo)
        return reply.status(400).send({ error: "from must be before to" });
      if (periodTo.getTime() - periodFrom.getTime() > MAX_PERIOD_DAYS * DAY_MS)
        return reply.status(400).send({ error: `period may not exceed ${MAX_PERIOD_DAYS} days` });

      const input = await loadInput(clientId, { from: periodFrom, to: periodTo }, at);
      if (!input) return reply.status(404).send({ error: "client not found" });
      const report = buildOutcomeReport(input);
      logger.info(
        { clientId, from: report.period.from, to: report.period.to },
        "Outcome report served",
      );
      return send(reply, format, report, renderOutcomeReportMarkdown(report));
    },
  );

  app.get<{ Params: { clientId: string }; Querystring: OutcomeQuery }>(
    "/api/reports/clients/:clientId/outcome/latest",
    async (request, reply) => {
      const { clientId } = request.params;
      if (!UUID.test(clientId)) return reply.status(400).send({ error: "clientId must be a uuid" });
      const { format } = request.query;
      if (format !== undefined && format !== "json" && format !== "markdown")
        return reply.status(400).send({ error: "format must be json or markdown" });
      const snapshot = await loadLatest(clientId);
      if (!snapshot)
        return reply.status(404).send({
          error: "no weekly outcome report stored yet",
          detail:
            "reports:outcome-weekly runs Mondays 07:00 UTC; use /outcome for a live report meanwhile",
        });
      return send(reply, format, snapshot.report, snapshot.markdown, {
        storedAt: snapshot.storedAt,
      });
    },
  );
}
