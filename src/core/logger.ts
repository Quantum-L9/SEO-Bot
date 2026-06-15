/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Structured Logger
 * Pino-based structured logging with per-module context.
 * All actions are logged for auditability and feedback loop learning.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import pino from 'pino';
import { getConfig } from './config.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  const config = getConfig();

  _logger = pino({
    level: config.BOT_LOG_LEVEL,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: process.stdout.isTTY,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
    base: {
      service: 'l9-seo-bot',
    },
  });

  return _logger;
}

export function createModuleLogger(module: string): pino.Logger {
  return getLogger().child({ module });
}
