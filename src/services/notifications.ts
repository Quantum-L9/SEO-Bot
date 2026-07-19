/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Notification Service
 * Multi-channel operator notifications: Email + Telegram
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import nodemailer from 'nodemailer';
import axios from 'axios';
import { getConfig } from '../core/config.js';
import { createModuleLogger } from '../core/logger.js';

const logger = createModuleLogger('notifications');

export type AlertSeverity = 'info' | 'warning' | 'critical';

interface Alert {
  title: string;
  message: string;
  severity: AlertSeverity;
  clientDomain?: string;
  module?: string;
  data?: Record<string, any>;
}

export class NotificationService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const config = getConfig();

    if (config.SMTP_PASSWORD) {
      this.transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: {
          user: config.SMTP_USER,
          pass: config.SMTP_PASSWORD,
        },
      });
    }
  }

  async sendAlert(alert: Alert): Promise<void> {
    const config = getConfig();

    logger.info({ title: alert.title, severity: alert.severity, client: alert.clientDomain }, 'Sending alert');

    const promises: Promise<void>[] = [];

    // Email
    if (this.transporter && config.OPERATOR_EMAIL) {
      promises.push(this.sendEmail(alert));
    }

    // Telegram
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      promises.push(this.sendTelegram(alert));
    }

    await Promise.allSettled(promises);
  }

  private async sendEmail(alert: Alert): Promise<void> {
    const config = getConfig();
    const severityEmoji = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

    try {
      await this.transporter!.sendMail({
        from: `"L9 SEO Bot" <${config.OUTREACH_FROM_EMAIL || 'bot@l9.dev'}>`,
        to: config.OPERATOR_EMAIL,
        subject: `${severityEmoji[alert.severity]} [L9 SEO] ${alert.title}`,
        html: `
          <div style="font-family: monospace; padding: 20px;">
            <h2>${alert.title}</h2>
            ${alert.clientDomain ? `<p><strong>Client:</strong> ${alert.clientDomain}</p>` : ''}
            ${alert.module ? `<p><strong>Module:</strong> ${alert.module}</p>` : ''}
            <p>${alert.message}</p>
            ${alert.data ? `<pre>${JSON.stringify(alert.data, null, 2)}</pre>` : ''}
            <hr/>
            <p style="color: #666; font-size: 12px;">L9 SEO Bot - Autonomous Monitoring</p>
          </div>
        `,
      });
      logger.debug('Email alert sent');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to send email alert');
    }
  }

  private async sendTelegram(alert: Alert): Promise<void> {
    const config = getConfig();
    const severityEmoji = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

    const text = [
      `${severityEmoji[alert.severity]} *${alert.title}*`,
      alert.clientDomain ? `📍 ${alert.clientDomain}` : '',
      alert.module ? `🔧 ${alert.module}` : '',
      '',
      alert.message,
      alert.data ? `\`\`\`\n${JSON.stringify(alert.data, null, 2)}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }, { timeout: 15_000 });
      logger.debug('Telegram alert sent');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to send Telegram alert');
    }
  }

  async sendWeeklyReport(report: {
    clientDomain: string;
    summary: string;
    htmlReport: string;
  }): Promise<void> {
    const config = getConfig();

    if (!this.transporter || !config.OPERATOR_EMAIL) return;

    try {
      await this.transporter.sendMail({
        from: `"L9 SEO Bot" <${config.OUTREACH_FROM_EMAIL || 'bot@l9.dev'}>`,
        to: config.OPERATOR_EMAIL,
        subject: `📊 [L9 SEO] Weekly Report - ${report.clientDomain}`,
        html: report.htmlReport,
      });
      logger.info({ client: report.clientDomain }, 'Weekly report sent');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to send weekly report');
    }
  }
}

// Singleton
let _notificationService: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!_notificationService) {
    _notificationService = new NotificationService();
  }
  return _notificationService;
}
