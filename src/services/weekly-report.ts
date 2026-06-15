/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Weekly Report Generator
 * 
 * Generates and delivers comprehensive weekly SEO reports:
 * - TO: Domain owner (per-client config)
 * - CC: Agency operator (OPERATOR_CC_EMAIL from env)
 * - Includes: actions taken, rationale, competitor triggers, pending approvals
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import nodemailer from 'nodemailer';
import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../core/database/index.js';
import { getConfig } from '../core/config.js';
import { createModuleLogger } from '../core/logger.js';

const logger = createModuleLogger('weekly-report');

// ─── Report Data Structures ───────────────────────────────────────────────────

interface WeeklyReportData {
  client: {
    name: string;
    domain: string;
    ownerEmail: string;
  };
  period: { from: Date; to: Date };
  rankings: {
    improved: Array<{ keyword: string; from: number; to: number }>;
    declined: Array<{ keyword: string; from: number; to: number }>;
    stable: number;
    avgPosition: number;
  };
  vitals: {
    lcp: { value: number; rating: string; trend: string };
    cls: { value: number; rating: string; trend: string };
    inp: { value: number; rating: string; trend: string };
  };
  actionsExecuted: Array<{
    action: string;
    description: string;
    rationale: string;
    triggeredBy: string;
    riskLevel: string;
    result: string;
  }>;
  pendingApprovals: Array<{
    id: string;
    action: string;
    description: string;
    options: Array<{
      label: string;
      recommended: boolean;
      confidence: number;
    }>;
    aiRecommendation: string;
  }>;
  competitorIntel: {
    topCompetitor: string;
    theirActions: string[];
    ourResponse: string;
  };
  linkBuilding: {
    prospectsDiscovered: number;
    outreachSent: number;
    linksAcquired: number;
    pendingResponses: number;
  };
  aeo: {
    queriesChecked: number;
    citationRate: number;
    newCitations: number;
  };
  tokenUsage: {
    totalSpent: number;
    budgetRemaining: number;
    callsMade: number;
  };
  behaviorInsights: Array<{
    insight: string;
    severity: string;
    recommendation: string;
  }>;
}

// ─── Data Collection ──────────────────────────────────────────────────────────

export async function collectWeeklyData(clientId: string): Promise<WeeklyReportData | null> {
  const db = getDb();
  const oneWeekAgo = new Date(Date.now() - 7 * 86400000);
  const now = new Date();

  // Get client
  const [client] = await db.select()
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  if (!client) return null;

  const clientConfig = (client.config as any) || {};

  // Rankings
  const rankings = await db.select()
    .from(schema.serpRankings)
    .where(and(
      eq(schema.serpRankings.clientId, clientId),
      gte(schema.serpRankings.checkedAt, oneWeekAgo),
    ))
    .orderBy(desc(schema.serpRankings.checkedAt));

  const improved = rankings
    .filter(r => r.previousPosition && r.position && r.position < r.previousPosition)
    .map(r => ({ keyword: r.keyword, from: r.previousPosition!, to: r.position! }));

  const declined = rankings
    .filter(r => r.previousPosition && r.position && r.position > r.previousPosition)
    .map(r => ({ keyword: r.keyword, from: r.previousPosition!, to: r.position! }));

  const positions = rankings.filter(r => r.position).map(r => r.position!);
  const avgPosition = positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : 0;

  // Vitals
  const vitals = await db.select()
    .from(schema.webVitals)
    .where(and(
      eq(schema.webVitals.clientId, clientId),
      gte(schema.webVitals.measuredAt, oneWeekAgo),
    ))
    .orderBy(desc(schema.webVitals.measuredAt))
    .limit(5);

  const latestVital = vitals[0];

  // Actions executed this week
  const actions = await db.select()
    .from(schema.actionLog)
    .where(and(
      eq(schema.actionLog.clientId, clientId),
      eq(schema.actionLog.status, 'auto_executed'),
      gte(schema.actionLog.createdAt, oneWeekAgo),
    ))
    .orderBy(desc(schema.actionLog.createdAt));

  // Pending approvals
  const pending = await db.select()
    .from(schema.actionLog)
    .where(and(
      eq(schema.actionLog.clientId, clientId),
      eq(schema.actionLog.status, 'pending_approval'),
    ))
    .orderBy(desc(schema.actionLog.createdAt));

  // Link building
  const prospects = await db.select()
    .from(schema.linkProspects)
    .where(and(
      eq(schema.linkProspects.clientId, clientId),
      gte(schema.linkProspects.createdAt, oneWeekAgo),
    ));

  // AEO citations
  const citations = await db.select()
    .from(schema.aeoCitations)
    .where(and(
      eq(schema.aeoCitations.clientId, clientId),
      gte(schema.aeoCitations.checkedAt, oneWeekAgo),
    ));

  const citationRate = citations.length > 0
    ? (citations.filter(c => c.cited).length / citations.length) * 100
    : 0;

  // Token usage
  const tokenResult = await db.select({
    total: sql<number>`COALESCE(SUM(cost), 0)`,
    calls: sql<number>`COUNT(*)`,
  })
    .from(schema.llmUsage)
    .where(and(
      eq(schema.llmUsage.clientId, clientId),
      gte(schema.llmUsage.timestamp, oneWeekAgo),
    ));

  return {
    client: {
      name: client.name,
      domain: client.domain,
      ownerEmail: clientConfig.ownerEmail || '',
    },
    period: { from: oneWeekAgo, to: now },
    rankings: {
      improved,
      declined,
      stable: rankings.length - improved.length - declined.length,
      avgPosition: Math.round(avgPosition * 10) / 10,
    },
    vitals: {
      lcp: { value: latestVital?.lcp || 0, rating: latestVital?.rating || 'unknown', trend: '→' },
      cls: { value: latestVital?.cls || 0, rating: latestVital?.rating || 'unknown', trend: '→' },
      inp: { value: latestVital?.inp || 0, rating: latestVital?.rating || 'unknown', trend: '→' },
    },
    actionsExecuted: actions.map(a => ({
      action: a.action,
      description: a.description,
      rationale: a.rationale,
      triggeredBy: a.triggeredBy,
      riskLevel: a.riskLevel,
      result: 'completed',
    })),
    pendingApprovals: pending.map(p => ({
      id: p.id,
      action: p.action,
      description: p.description,
      options: p.options ? JSON.parse(p.options as string) : [],
      aiRecommendation: p.aiRecommendation || '',
    })),
    competitorIntel: {
      topCompetitor: 'See gap analyses',
      theirActions: [],
      ourResponse: '',
    },
    linkBuilding: {
      prospectsDiscovered: prospects.length,
      outreachSent: prospects.filter(p => p.status === 'outreach_queued').length,
      linksAcquired: prospects.filter(p => p.status === 'link_acquired').length,
      pendingResponses: prospects.filter(p => p.status === 'awaiting_response').length,
    },
    aeo: {
      queriesChecked: citations.length,
      citationRate,
      newCitations: citations.filter(c => c.cited).length,
    },
    tokenUsage: {
      totalSpent: tokenResult[0]?.total || 0,
      budgetRemaining: (clientConfig.dailyTokenBudget || 2.00) * 7 - (tokenResult[0]?.total || 0),
      callsMade: tokenResult[0]?.calls || 0,
    },
    behaviorInsights: [],
  };
}

// ─── HTML Report Template ─────────────────────────────────────────────────────

function generateHtmlReport(data: WeeklyReportData): string {
  const { client, period, rankings, vitals, actionsExecuted, pendingApprovals, linkBuilding, aeo, tokenUsage, behaviorInsights } = data;

  const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const actionsHtml = actionsExecuted.length > 0
    ? actionsExecuted.map(a => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${a.action}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${a.description}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${a.rationale}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; font-style: italic; color: #666;">${a.triggeredBy}</td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><span style="background: ${a.riskLevel === 'low' ? '#d4edda' : a.riskLevel === 'medium' ? '#fff3cd' : '#f8d7da'}; padding: 2px 8px; border-radius: 4px;">${a.riskLevel}</span></td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" style="padding: 8px; text-align: center; color: #999;">No actions executed this week</td></tr>';

  const pendingHtml = pendingApprovals.length > 0
    ? pendingApprovals.map(p => `
      <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
        <h4 style="margin: 0 0 8px 0;">${p.action}</h4>
        <p style="margin: 0 0 8px 0;">${p.description}</p>
        ${p.options.length > 0 ? `
          <p style="font-weight: bold; margin: 8px 0 4px 0;">Options:</p>
          <ul style="margin: 0; padding-left: 20px;">
            ${p.options.map(o => `<li>${o.recommended ? '<strong>' : ''}${o.label} (confidence: ${(o.confidence * 100).toFixed(0)}%)${o.recommended ? ' ← AI Recommended</strong>' : ''}</li>`).join('')}
          </ul>
        ` : ''}
        ${p.aiRecommendation ? `<p style="margin: 8px 0 0 0; color: #856404;"><strong>AI Recommendation:</strong> ${p.aiRecommendation}</p>` : ''}
        <p style="margin: 8px 0 0 0; font-size: 12px; color: #666;">Reply to this email with the option letter to approve, or "reject" to decline.</p>
      </div>
    `).join('')
    : '<p style="color: #28a745;">No pending approvals — all clear.</p>';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333;">
  
  <!-- Header -->
  <div style="background: linear-gradient(135deg, #1a237e, #283593); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
    <h1 style="margin: 0; font-size: 24px;">Weekly SEO Report</h1>
    <p style="margin: 8px 0 0 0; opacity: 0.9;">${client.domain} | ${formatDate(period.from)} – ${formatDate(period.to)}</p>
  </div>

  <!-- Rankings Summary -->
  <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 12px 0; font-size: 18px;">Rankings</h2>
    <div style="display: flex; gap: 20px;">
      <div style="text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #28a745;">${rankings.improved.length}</div>
        <div style="font-size: 12px; color: #666;">Improved</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #dc3545;">${rankings.declined.length}</div>
        <div style="font-size: 12px; color: #666;">Declined</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #6c757d;">${rankings.stable}</div>
        <div style="font-size: 12px; color: #666;">Stable</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 28px; font-weight: bold; color: #007bff;">${rankings.avgPosition}</div>
        <div style="font-size: 12px; color: #666;">Avg Position</div>
      </div>
    </div>
    ${rankings.improved.length > 0 ? `
      <p style="margin: 12px 0 4px 0; font-weight: bold; color: #28a745;">Top Movers:</p>
      <ul style="margin: 0; padding-left: 20px;">
        ${rankings.improved.slice(0, 5).map(r => `<li>"${r.keyword}" — moved from #${r.from} to #${r.to}</li>`).join('')}
      </ul>
    ` : ''}
  </div>

  <!-- Web Vitals -->
  <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 12px 0; font-size: 18px;">Core Web Vitals</h2>
    <table style="width: 100%; border-collapse: collapse;">
      <tr>
        <td style="padding: 8px;"><strong>LCP</strong></td>
        <td style="padding: 8px;">${vitals.lcp.value ? vitals.lcp.value.toFixed(1) + 's' : 'N/A'}</td>
        <td style="padding: 8px;">${vitals.lcp.rating}</td>
      </tr>
      <tr>
        <td style="padding: 8px;"><strong>CLS</strong></td>
        <td style="padding: 8px;">${vitals.cls.value ? vitals.cls.value.toFixed(3) : 'N/A'}</td>
        <td style="padding: 8px;">${vitals.cls.rating}</td>
      </tr>
      <tr>
        <td style="padding: 8px;"><strong>INP</strong></td>
        <td style="padding: 8px;">${vitals.inp.value ? vitals.inp.value.toFixed(0) + 'ms' : 'N/A'}</td>
        <td style="padding: 8px;">${vitals.inp.rating}</td>
      </tr>
    </table>
  </div>

  <!-- Actions Taken -->
  <div style="margin-bottom: 20px;">
    <h2 style="font-size: 18px;">Actions Taken This Week</h2>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      <thead>
        <tr style="background: #e9ecef;">
          <th style="padding: 8px; text-align: left;">Action</th>
          <th style="padding: 8px; text-align: left;">What</th>
          <th style="padding: 8px; text-align: left;">Why</th>
          <th style="padding: 8px; text-align: left;">Triggered By</th>
          <th style="padding: 8px; text-align: left;">Risk</th>
        </tr>
      </thead>
      <tbody>
        ${actionsHtml}
      </tbody>
    </table>
  </div>

  <!-- Pending Approvals -->
  <div style="margin-bottom: 20px;">
    <h2 style="font-size: 18px;">Pending Approvals</h2>
    ${pendingHtml}
  </div>

  <!-- Link Building -->
  <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 12px 0; font-size: 18px;">Link Building</h2>
    <p>Prospects discovered: <strong>${linkBuilding.prospectsDiscovered}</strong> | Outreach sent: <strong>${linkBuilding.outreachSent}</strong> | Links acquired: <strong>${linkBuilding.linksAcquired}</strong> | Awaiting response: <strong>${linkBuilding.pendingResponses}</strong></p>
  </div>

  <!-- AEO / AI Search -->
  <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 12px 0; font-size: 18px;">AI Search (AEO)</h2>
    <p>Queries checked: <strong>${aeo.queriesChecked}</strong> | Citation rate: <strong>${aeo.citationRate.toFixed(1)}%</strong> | New citations: <strong>${aeo.newCitations}</strong></p>
  </div>

  <!-- Token Usage -->
  <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 12px 0; font-size: 18px;">AI Token Usage</h2>
    <p>Spent this week: <strong>$${tokenUsage.totalSpent.toFixed(2)}</strong> | Budget remaining: <strong>$${tokenUsage.budgetRemaining.toFixed(2)}</strong> | LLM calls: <strong>${tokenUsage.callsMade}</strong></p>
  </div>

  <!-- Behavior Insights -->
  ${behaviorInsights.length > 0 ? `
  <div style="margin-bottom: 20px;">
    <h2 style="font-size: 18px;">Behavior Insights</h2>
    ${behaviorInsights.map(i => `<p><strong>${i.severity}:</strong> ${i.insight} — <em>${i.recommendation}</em></p>`).join('')}
  </div>
  ` : ''}

  <!-- Footer -->
  <div style="border-top: 1px solid #dee2e6; padding-top: 16px; margin-top: 24px; font-size: 12px; color: #6c757d;">
    <p>Generated by L9 SEO Bot | Autonomous SEO Maintenance Engine</p>
    <p>To approve pending actions, reply to this email with the option letter. To reject, reply "reject [action-id]".</p>
  </div>

</body>
</html>`;
}

// ─── Report Delivery ──────────────────────────────────────────────────────────

export async function generateAndDeliverWeeklyReport(clientId: string): Promise<void> {
  const config = getConfig();
  const data = await collectWeeklyData(clientId);

  if (!data) {
    logger.warn({ clientId }, 'No client found for weekly report');
    return;
  }

  const htmlReport = generateHtmlReport(data);

  // Build recipient list
  const toEmail = data.client.ownerEmail;
  const ccEmail = config.OPERATOR_CC_EMAIL;

  if (!toEmail && !ccEmail) {
    logger.warn({ clientId, domain: data.client.domain }, 'No recipient configured for weekly report');
    return;
  }

  // Send email
  if (!config.SMTP_PASSWORD) {
    logger.warn('SMTP not configured — weekly report not sent');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASSWORD,
    },
  });

  const recipients = toEmail || ccEmail!;
  const cc = toEmail && ccEmail ? ccEmail : undefined;

  try {
    await transporter.sendMail({
      from: `"L9 SEO Bot" <${config.OUTREACH_FROM_EMAIL || 'bot@l9.dev'}>`,
      to: recipients,
      cc,
      subject: `Weekly SEO Report — ${data.client.domain} (${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
      html: htmlReport,
    });

    logger.info({
      client: data.client.domain,
      to: recipients,
      cc,
      actionsReported: data.actionsExecuted.length,
      pendingApprovals: data.pendingApprovals.length,
    }, 'Weekly report delivered');
  } catch (error: any) {
    logger.error({ error: error.message, client: data.client.domain }, 'Failed to deliver weekly report');
  }
}
