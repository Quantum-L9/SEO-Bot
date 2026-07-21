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
 * this upserts on `clients.domain` so re-deploys refresh an existing client.
 *
 * Two shapes, one contract (both schema_version '2.0'):
 *   • Flat v2 (no `site` block) — behaves EXACTLY as before: upsert, active,
 *     `201 { registered, clientId }`. No readiness gate. Zero behavior change.
 *   • Enriched v2 (carries the `site` provenance block) — fail-closed: SEO-Bot
 *     verifies GitHub maintenance readiness before activating; on failure the
 *     client is still registered but maintenance stays inactive.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getDb, schema } from '../../core/database/index.js';
import { createModuleLogger } from '../../core/logger.js';
import {
  WebsiteFactoryContractV2,
  hasEnrichedSite,
  verifyContractIntegrity,
  type EnrichedWebsiteFactoryContractV2,
} from '../../contracts/website_factory_v2.js';
import {
  MaintenanceReadinessError,
  verifyMaintenanceReadiness,
  type MaintenanceReadinessDeps,
  type MaintenanceReadinessResult,
} from '../../services/maintenance-readiness.js';

const logger = createModuleLogger('api:register');

export interface RegisterClientRouteDeps extends MaintenanceReadinessDeps {}

/** Constant-time string compare (avoids leaking the key via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

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

/** Build the `config` jsonb for a flat v2 payload (unchanged from the original route). */
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

/** Build the `config` jsonb for a verified enriched v2 payload (canonical site_deployment). */
function buildEnrichedClientConfig(
  payload: EnrichedWebsiteFactoryContractV2,
  readiness: MaintenanceReadinessResult,
) {
  const repo = payload.site.repository;
  const deployment = payload.site.deployment;
  return {
    targetKeywords: payload.targetKeywords,
    competitorUrls: payload.competitorUrls ?? [],
    vercelUrl: deployment.deployment_url,
    industry: payload.industry,
    city: payload.city,
    state: payload.state,
    seo_contract: payload.seo_contract,
    website_factory_handoff: {
      schemaVersion: payload.schema_version,
      receiptId: payload.proof?.receipt_id,
      sourceDigest: payload.proof?.source_digest,
      distDigest: payload.proof?.dist_digest,
      contractDigest: payload.integrity?.payload_digest,
      verifiedAt: readiness.verifiedAt,
    },
    site_deployment: {
      schemaVersion: payload.schema_version,
      status: 'ready' as const,
      transport: payload.site.maintenance.transport,
      githubCredentialRef: readiness.githubCredentialRef,
      vercelDeployHookRef: readiness.vercelDeployHookRef,
      websiteBotRepo: repo.full_name,
      repositoryId: repo.repository_id,
      sourceBranch: repo.branch,
      verifiedCommitSha: readiness.verifiedCommitSha,
      sourceDigest: repo.source_digest,
      managedManifestPath: repo.managed_manifest_path,
      editableRoot: repo.editable_root,
      pagePathStrategy: repo.page_path_strategy,
      vercelProjectId: deployment.project_id,
      vercelDeploymentId: deployment.deployment_id,
      deploymentUrl: deployment.deployment_url,
      contractId: payload.proof?.receipt_id,
      contractDigest: payload.integrity?.payload_digest,
      verifiedAt: readiness.verifiedAt,
    },
  };
}

export async function registerClientRoutes(app: FastifyInstance, deps: RegisterClientRouteDeps = {}): Promise<void> {
  app.post('/api/clients/register', async (request, reply) => {
    const env = deps.env ?? process.env;
    // API-key gate — fail closed.
    const expectedKey = env.SEO_BOT_API_KEY;
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

    // ── Enriched v2: verified, fail-closed maintenance activation ────────────────
    if (hasEnrichedSite(payload)) {
      if (!verifyContractIntegrity(payload)) {
        return reply.status(400).send({ registered: false, maintenance_ready: false, error: 'integrity_digest_mismatch' });
      }

      let readiness: MaintenanceReadinessResult;
      try {
        readiness = await verifyMaintenanceReadiness(payload, deps);
      } catch (error) {
        if (!(error instanceof MaintenanceReadinessError)) throw error;
        // Fail closed: register the client but leave maintenance inactive.
        logger.warn({ code: error.code, probes: error.probes, domain }, 'Maintenance readiness failed; registering inactive');
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
              config: buildClientConfig(payload),
              active: false,
            })
            .onConflictDoUpdate({
              target: schema.clients.domain,
              set: { config: buildClientConfig(payload), active: false, updatedAt: new Date() },
            })
            .returning();
          return reply.status(202).send({
            registered: true,
            maintenance_ready: false,
            clientId: client.id,
            error: error.code,
            probes: error.probes,
          });
        } catch (dbErr: any) {
          logger.error({ err: dbErr, domain }, 'Inactive registration write failed');
          return reply.status(409).send({ registered: false, maintenance_ready: false, error: dbErr?.message ?? 'registration_failed' });
        }
      }

      const config = buildEnrichedClientConfig(payload, readiness);
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
            active: true,
          })
          .onConflictDoUpdate({
            target: schema.clients.domain,
            set: {
              name: payload.name,
              industry: payload.industry,
              city: payload.city ?? null,
              state: payload.state ?? null,
              config,
              active: true,
              updatedAt: new Date(),
            },
          })
          .returning();
        logger.info({ clientId: client.id, domain, commit: readiness.verifiedCommitSha }, 'Client registered with verified maintenance readiness');
        return reply.status(201).send({
          registered: true,
          maintenance_ready: true,
          clientId: client.id,
          verified_commit_sha: readiness.verifiedCommitSha,
          probes: readiness.probes,
        });
      } catch (err: any) {
        logger.error({ err, domain }, 'Verified registration write failed');
        return reply.status(409).send({ registered: false, maintenance_ready: false, error: err?.message ?? 'registration_failed' });
      }
    }

    // ── Flat v2: unchanged behavior (byte-identical to the original route) ────────
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
