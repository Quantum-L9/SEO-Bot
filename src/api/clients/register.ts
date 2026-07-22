/* L9_META: layer=api, role=website_factory_handoff, status=active, version=3.0.0 */
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getDb, schema } from '../../core/database/index.js';
import { createModuleLogger } from '../../core/logger.js';
import { WebsiteFactoryContractV2 } from '../../contracts/website_factory_v2.js';
import {
  WebsiteFactoryHandoffV3,
  verifyHandoffIntegrity,
  type WebsiteFactoryHandoffV3 as WebsiteFactoryHandoffV3Type,
} from '../../contracts/website_factory_v3.js';
import {
  MaintenanceReadinessError,
  verifyMaintenanceReadiness,
  type MaintenanceReadinessDeps,
  type MaintenanceReadinessResult,
} from '../../services/maintenance-readiness.js';

const logger = createModuleLogger('api:register');

export interface RegisterClientRouteDeps extends MaintenanceReadinessDeps {}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(header: string | undefined): string {
  return typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
}

function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function buildClientConfigV3(payload: WebsiteFactoryHandoffV3Type, readiness: MaintenanceReadinessResult) {
  return {
    targetKeywords: payload.seo.target_keywords,
    competitorUrls: payload.seo.competitor_urls,
    vercelUrl: payload.site.deployment.deployment_url,
    industry: payload.client.industry,
    city: payload.client.city,
    state: payload.client.state,
    website_factory_handoff: {
      protocol: payload.protocol,
      schemaVersion: payload.schema_version,
      contractId: payload.contract_id,
      contractDigest: payload.integrity.payload_digest,
      receiptId: payload.proof.receipt_id,
      sourceDigest: payload.proof.source_digest,
      distDigest: payload.proof.dist_digest,
      verifiedAt: readiness.verifiedAt,
    },
    site_deployment: {
      schemaVersion: payload.schema_version,
      status: 'ready' as const,
      transport: payload.site.maintenance.transport,
      githubCredentialRef: readiness.githubCredentialRef,
      vercelDeployHookRef: readiness.vercelDeployHookRef,
      websiteBotRepo: payload.site.repository.full_name,
      repositoryId: payload.site.repository.repository_id,
      sourceBranch: payload.site.repository.branch,
      verifiedCommitSha: readiness.verifiedCommitSha,
      sourceDigest: payload.site.repository.source_digest,
      managedManifestPath: payload.site.repository.managed_manifest_path,
      editableRoot: payload.site.repository.editable_root,
      pagePathStrategy: payload.site.repository.page_path_strategy,
      vercelProjectId: payload.site.deployment.project_id,
      vercelDeploymentId: payload.site.deployment.deployment_id,
      deploymentUrl: payload.site.deployment.deployment_url,
      contractId: payload.contract_id,
      contractDigest: payload.integrity.payload_digest,
      verifiedAt: readiness.verifiedAt,
    },
  };
}

function buildLegacyConfig(payload: import('../../contracts/website_factory_v2.js').WebsiteFactoryContractV2) {
  return {
    targetKeywords: payload.targetKeywords,
    competitorUrls: payload.competitorUrls ?? [],
    vercelUrl: payload.vercelUrl,
    industry: payload.industry,
    city: payload.city,
    state: payload.state,
    seo_contract: payload.seo_contract,
    site_deployment: { status: 'unverified', schemaVersion: '2.0' },
  };
}

export async function registerClientRoutes(app: FastifyInstance, deps: RegisterClientRouteDeps = {}): Promise<void> {
  app.post('/api/clients/register', async (request, reply) => {
    const env = deps.env ?? process.env;
    const expectedKey = env.SEO_BOT_API_KEY;
    if (!expectedKey) {
      logger.error({ ip: request.ip }, 'Registration rejected: SEO_BOT_API_KEY not configured');
      return reply.status(503).send({ registered: false, maintenance_ready: false, error: 'registration_not_configured' });
    }
    const token = bearerToken(request.headers.authorization);
    if (!token || !safeEqual(token, expectedKey)) {
      logger.warn({ ip: request.ip }, 'Rejected register request: bad or missing API key');
      return reply.status(401).send({ registered: false, maintenance_ready: false, error: 'unauthorized' });
    }

    const v3 = WebsiteFactoryHandoffV3.safeParse(request.body);
    if (v3.success) {
      const payload = v3.data;
      if (request.headers['idempotency-key'] !== payload.contract_id) {
        return reply.status(400).send({ registered: false, maintenance_ready: false, error: 'idempotency_key_mismatch' });
      }
      if (!verifyHandoffIntegrity(payload)) {
        return reply.status(400).send({ registered: false, maintenance_ready: false, error: 'integrity_digest_mismatch' });
      }

      let readiness: MaintenanceReadinessResult;
      try {
        readiness = await verifyMaintenanceReadiness(payload, deps);
      } catch (error) {
        if (error instanceof MaintenanceReadinessError) {
          logger.warn({ code: error.code, probes: error.probes, contractId: payload.contract_id }, 'Maintenance readiness verification failed');
          return reply.status(422).send({
            registered: false,
            maintenance_ready: false,
            error: error.code,
            detail: error.message,
            probes: error.probes,
          });
        }
        throw error;
      }

      const domain = normalizeDomain(payload.client.domain);
      const config = buildClientConfigV3(payload, readiness);
      try {
        const [client] = await getDb()
          .insert(schema.clients)
          .values({
            name: payload.client.name,
            domain,
            industry: payload.client.industry,
            city: payload.client.city ?? null,
            state: payload.client.state ?? null,
            config,
            active: true,
          })
          .onConflictDoUpdate({
            target: schema.clients.domain,
            set: {
              name: payload.client.name,
              industry: payload.client.industry,
              city: payload.client.city ?? null,
              state: payload.client.state ?? null,
              config,
              active: true,
              updatedAt: new Date(),
            },
          })
          .returning();

        logger.info({ clientId: client.id, domain, contractId: payload.contract_id }, 'Client registered with verified maintenance readiness');
        return reply.status(201).send({
          schema: 'seo-bot.website-factory-registration-ack/v1',
          registered: true,
          maintenance_ready: true,
          client_id: payload.client.id,
          contract_id: payload.contract_id,
          contract_digest: payload.integrity.payload_digest,
          release_receipt_id: payload.proof.receipt_id,
          verified_repository: payload.site.repository.full_name,
          verified_branch: payload.site.repository.branch,
          verified_commit_sha: readiness.verifiedCommitSha,
          probes: readiness.probes.filter(probe => probe.ok).map(probe => ({ ...probe, ok: true as const })),
          acknowledged_at: readiness.verifiedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message, domain }, 'Client registration failed');
        return reply.status(409).send({ registered: false, maintenance_ready: false, error: message });
      }
    }

    if (!envFlag(env.SEO_BOT_ALLOW_LEGACY_REGISTRATION)) {
      return reply.status(400).send({
        registered: false,
        maintenance_ready: false,
        error: 'canonical_v3_handoff_required',
        details: v3.error.flatten(),
      });
    }

    const legacy = WebsiteFactoryContractV2.safeParse(request.body);
    if (!legacy.success) {
      return reply.status(400).send({ registered: false, maintenance_ready: false, error: legacy.error.flatten() });
    }
    const payload = legacy.data;
    const domain = normalizeDomain(payload.domain);
    const config = buildLegacyConfig(payload);
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
          active: false,
        })
        .onConflictDoUpdate({
          target: schema.clients.domain,
          set: { config, active: false, updatedAt: new Date() },
        })
        .returning();
      return reply.status(202).send({
        registered: true,
        maintenance_ready: false,
        client_id: client.id,
        warning: 'legacy_v2_registered_inactive',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(409).send({ registered: false, maintenance_ready: false, error: message });
    }
  });
}
