/* L9_META
 * layer: api
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Client Registration Route
 *
 * POST /api/clients/register
 *
 * The webhook onboarding path for the Website Factory v2 handoff. Website-Bot
 * POSTs a `WebsiteFactoryContractV2` payload here after a successful deploy;
 * previously no such route existed, so the handoff silently 404'd. This upserts
 * on `clients.domain` so re-deploys refresh an existing client rather than
 * failing on the unique constraint.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getDb, schema } from '../../core/database/index.js';
import { createModuleLogger } from '../../core/logger.js';
import { WebsiteFactoryContractV2 } from '../../contracts/website_factory_v2.js';

const logger = createModuleLogger('api:register');

/** Constant-time string compare (avoids leaking the key via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Extract a `Bearer <token>` value from the Authorization header.
 * Website-Bot's HandoffEmitterStage sends `Authorization: Bearer $SEO_BOT_API_KEY`.
 */
function bearerToken(header: string | undefined): string {
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
}

/** Strip protocol / www / trailing slash and lowercase, matching add-client.ts. */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

/** Build the `config` jsonb the downstream SEO modules read. */
function buildClientConfig(payload: WebsiteFactoryContractV2) {
  return {
    targetKeywords: payload.targetKeywords,
    competitorUrls: payload.competitorUrls ?? [],
    vercelUrl: payload.vercelUrl,
    industry: payload.industry,
    city: payload.city,
    state: payload.state,
    seo_contract: payload.seo_contract,
  };
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/clients/register', async (request, reply) => {
    // API-key gate — fail closed. The caller (Website-Bot) presents the shared
    // secret as `Authorization: Bearer <key>`. If SEO_BOT_API_KEY is not
    // configured, we refuse rather than accept anonymous tenant upserts.
    const expectedKey = process.env.SEO_BOT_API_KEY;
    if (!expectedKey) {
      logger.error({ ip: request.ip }, 'Registration rejected: SEO_BOT_API_KEY not configured');
      return reply.status(503).send({ registered: false, error: 'registration not configured' });
    }
    const token = bearerToken(request.headers.authorization);
    if (!token || !safeEqual(token, expectedKey)) {
      logger.warn({ ip: request.ip }, 'Rejected register request: bad or missing API key');
      return reply.status(401).send({ registered: false, error: 'unauthorized' });
    }

    const parsed = WebsiteFactoryContractV2.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ registered: false, error: parsed.error.flatten() });
    }

    const payload = parsed.data;
    const domain = normalizeDomain(payload.domain);
    const config = buildClientConfig(payload);

    try {
      const [client] = await getDb()
        .insert(schema.clients)
        .values({
          name: payload.name,
          domain,
          industry: payload.industry,
          city: payload.city ?? null,
          state: payload.state ?? null,
          posthogProjectId: payload.posthog_project_id ?? null,
          posthogApiKey: payload.posthog_api_key ?? null,
          config,
        })
        .onConflictDoUpdate({
          target: schema.clients.domain,
          set: {
            name: payload.name,
            industry: payload.industry,
            city: payload.city ?? null,
            state: payload.state ?? null,
            posthogProjectId: payload.posthog_project_id ?? null,
            posthogApiKey: payload.posthog_api_key ?? null,
            config,
            active: true,
            updatedAt: new Date(),
          },
        })
        .returning();

      logger.info({ clientId: client.id, domain }, 'Client registered via Website Factory v2 handoff');
      return reply.status(201).send({ registered: true, clientId: client.id });
    } catch (err: any) {
      logger.error({ err, domain }, 'Client registration failed');
      return reply.status(409).send({ registered: false, error: err?.message ?? 'registration_failed' });
    }
  });
}
