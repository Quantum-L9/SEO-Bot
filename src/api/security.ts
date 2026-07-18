/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - API Security Middleware
 *
 * Two onRequest hooks, registered before all routes:
 *   1. Fixed-window per-IP rate limiter (dependency-free, single-instance).
 *   2. Operator authentication (shared secret via Basic password or Bearer).
 *
 * Fail-closed: if OPERATOR_API_KEY is unset, every protected route returns 401.
 * Exempt: /health (liveness) and /api/clients/register (authenticated by its
 * own SEO_BOT_API_KEY machine handoff).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../core/config.js';
import { createModuleLogger } from '../core/logger.js';

const logger = createModuleLogger('api:security');

/** Routes reachable without operator auth. */
const AUTH_EXEMPT = ['/health', '/api/clients/register'];

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_DEFAULT = 120; // requests / IP / minute
const RATE_MAX_STRICT = 10; // stricter cap for expensive/abusable routes
const RATE_MAX_BUCKETS = 20_000; // memory guard

interface RateBucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, RateBucket>();

/** Constant-time string compare (avoids leaking the secret via timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Extract the presented secret from an Authorization header.
 * Supports `Bearer <token>` and HTTP `Basic <base64(user:pass)>` (the password
 * portion is used, so browsers can authenticate via a native login prompt).
 * Returns null when no usable credential is present.
 */
export function parseAuthSecret(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token || null;
  }
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
      return pass || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when the path is a rate-limited-stricter, expensive/abusable route. */
export function isStrictRateLimited(pathname: string): boolean {
  return pathname === '/api/clients/register' || /^\/api\/clients\/[^/]+\/trigger$/.test(pathname);
}

function pathname(url: string): string {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function isAuthExempt(path: string): boolean {
  return AUTH_EXEMPT.some((p) => path === p || path.startsWith(p + '/'));
}

export function registerApiSecurity(app: FastifyInstance): void {
  // ── 1. Rate limiter (runs first, so unauthenticated floods are also capped) ──
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    // Bound memory under IP churn: prune expired buckets, then hard-evict the
    // oldest-inserted entries if we're still over the cap (a burst of unique IPs
    // within a single window won't have expired yet). Map preserves insertion
    // order, so the first keys are the oldest.
    if (buckets.size > RATE_MAX_BUCKETS) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      while (buckets.size > RATE_MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    const path = pathname(request.url);
    const strict = isStrictRateLimited(path);
    const max = strict ? RATE_MAX_STRICT : RATE_MAX_DEFAULT;
    const key = `${request.ip}:${strict ? 's' : 'd'}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      reply.header('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      logger.warn({ ip: request.ip, path }, 'Rate limit exceeded');
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }
  });

  // ── 2. Operator authentication ───────────────────────────────────────────────
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = pathname(request.url);
    if (isAuthExempt(path)) return;

    const key = getConfig().OPERATOR_API_KEY;
    if (!key) {
      logger.error({ path }, 'OPERATOR_API_KEY not configured; operator API is locked');
      reply.header('WWW-Authenticate', 'Basic realm="L9 SEO Bot"');
      return reply.status(401).send({ error: 'operator authentication not configured' });
    }

    const presented = parseAuthSecret(request.headers.authorization);
    if (!presented || !constantTimeEqual(presented, key)) {
      logger.warn({ ip: request.ip, path }, 'Rejected unauthenticated operator request');
      reply.header('WWW-Authenticate', 'Basic realm="L9 SEO Bot"');
      return reply.status(401).send({ error: 'unauthorized' });
    }
  });
}

/** Test hook: clear the in-memory rate-limit state. */
export function _resetRateLimiter(): void {
  buckets.clear();
}
