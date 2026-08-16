/* L9_META
 * layer: api
 * role: canonical_website_handoff_ingress
 * status: active
 * version: 3.0.0
 */

import { timingSafeEqual } from "node:crypto";
import {
  assertWebsiteFactoryHandoffV3,
  buildSeoBotRegistrationAck,
  type WebsiteFactoryHandoffV3,
} from "@quantum-l9/bot-interop";
import type { FastifyInstance } from "fastify";
import { getDb, schema } from "../../core/database/index.js";
import { createModuleLogger } from "../../core/logger.js";
import { getLlmService } from "../../services/llm.js";
import {
  type MaintenanceReadinessDeps,
  MaintenanceReadinessError,
  type MaintenanceReadinessResult,
  verifyMaintenanceReadiness,
} from "../../services/maintenance-readiness.js";

const logger = createModuleLogger("api:register");
export type RegisterClientRouteDeps = MaintenanceReadinessDeps;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function bearerToken(header: string | undefined): string {
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : "";
}
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function buildClientConfig(
  contract: WebsiteFactoryHandoffV3,
  readiness?: MaintenanceReadinessResult,
) {
  const repo = contract.site.repository;
  const deployment = contract.site.deployment;
  return {
    canonicalClientId: contract.client.id,
    targetKeywords: contract.seo.target_keywords.map((item) => ({
      keyword: item.keyword,
      priority: item.priority,
    })),
    competitorUrls: contract.seo.competitor_urls,
    vercelUrl: deployment.deployment_url,
    industry: contract.client.industry,
    city: contract.client.city,
    state: contract.client.state,
    website_factory_handoff: {
      protocol: contract.protocol,
      schemaVersion: contract.schema_version,
      contractId: contract.contract_id,
      receiptId: contract.proof.receipt_id,
      sourceDigest: contract.proof.source_digest,
      distDigest: contract.proof.dist_digest,
      contractDigest: contract.integrity.payload_digest,
      emittedAt: contract.emitted_at,
      ...(readiness ? { verifiedAt: readiness.verifiedAt } : {}),
    },
    site_deployment: {
      status: readiness ? "ready" : "inactive",
      transport: contract.site.maintenance.transport,
      githubCredentialRef:
        readiness?.githubCredentialRef ?? contract.site.maintenance.github_credential_ref,
      vercelDeployHookRef:
        readiness?.vercelDeployHookRef ?? contract.site.maintenance.vercel_deploy_hook_ref,
      websiteBotRepo: repo.full_name,
      repositoryId: repo.repository_id,
      sourceBranch: repo.branch,
      verifiedCommitSha: readiness?.verifiedCommitSha,
      sourceDigest: repo.source_digest,
      managedManifestPath: repo.managed_manifest_path,
      editableRoot: repo.editable_root,
      pagePathStrategy: repo.page_path_strategy,
      vercelProjectId: deployment.project_id,
      vercelDeploymentId: deployment.deployment_id,
      deploymentUrl: deployment.deployment_url,
      contractId: contract.contract_id,
      contractDigest: contract.integrity.payload_digest,
      ...(readiness ? { verifiedAt: readiness.verifiedAt } : {}),
    },
  };
}

export async function registerClientRoutes(
  app: FastifyInstance,
  deps: RegisterClientRouteDeps = {},
): Promise<void> {
  app.post("/api/clients/register", async (request, reply) => {
    const env = deps.env ?? process.env;
    const expectedKey = env.SEO_BOT_API_KEY;
    if (!expectedKey)
      return reply.status(503).send({ registered: false, error: "registration not configured" });
    const token = bearerToken(request.headers.authorization);
    if (!token || !safeEqual(token, expectedKey))
      return reply.status(401).send({ registered: false, error: "unauthorized" });

    let contract: WebsiteFactoryHandoffV3;
    try {
      assertWebsiteFactoryHandoffV3(request.body);
      contract = request.body;
    } catch (error) {
      return reply
        .status(400)
        .send({ registered: false, error: error instanceof Error ? error.message : String(error) });
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (idempotencyKey && idempotencyKey !== contract.contract_id) {
      return reply
        .status(409)
        .send({ registered: false, error: "idempotency_key_contract_mismatch" });
    }

    const domain = normalizeDomain(contract.client.domain);
    let readiness: MaintenanceReadinessResult;
    try {
      readiness = await verifyMaintenanceReadiness(contract, deps);
    } catch (error) {
      if (!(error instanceof MaintenanceReadinessError)) throw error;
      const config = buildClientConfig(contract);
      const [client] = await getDb()
        .insert(schema.clients)
        .values({
          name: contract.client.name,
          domain,
          industry: contract.client.industry,
          city: contract.client.city ?? null,
          state: contract.client.state ?? null,
          config,
          active: false,
        })
        .onConflictDoUpdate({
          target: schema.clients.domain,
          set: {
            name: contract.client.name,
            industry: contract.client.industry,
            city: contract.client.city ?? null,
            state: contract.client.state ?? null,
            config,
            active: false,
            updatedAt: new Date(),
          },
        })
        .returning();
      logger.warn(
        { clientId: client.id, domain, code: error.code },
        "Maintenance readiness failed; client remains inactive",
      );
      return reply.status(202).send({
        registered: true,
        maintenance_ready: false,
        clientId: client.id,
        error: error.code,
        probes: error.probes,
      });
    }

    const config = buildClientConfig(contract, readiness);
    const [client] = await getDb()
      .insert(schema.clients)
      .values({
        name: contract.client.name,
        domain,
        industry: contract.client.industry,
        city: contract.client.city ?? null,
        state: contract.client.state ?? null,
        config,
        active: true,
      })
      .onConflictDoUpdate({
        target: schema.clients.domain,
        set: {
          name: contract.client.name,
          industry: contract.client.industry,
          city: contract.client.city ?? null,
          state: contract.client.state ?? null,
          config,
          active: true,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Persist per-client LLM budgets at registration (fail-open on budget init).
    try {
      await getLlmService().initClient(client.id);
    } catch (error) {
      logger.warn(
        { clientId: client.id, error: error instanceof Error ? error.message : String(error) },
        "Client registered but LLM budget init failed",
      );
    }

    const ack = buildSeoBotRegistrationAck(
      contract,
      readiness.probes
        .filter((probe) => probe.ok)
        .map((probe) => ({ name: probe.name, ok: true as const, detail: probe.detail })),
      readiness.verifiedAt,
    );
    logger.info(
      {
        clientId: client.id,
        canonicalClientId: contract.client.id,
        domain,
        commit: readiness.verifiedCommitSha,
      },
      "Client registered with verified maintenance readiness",
    );
    return reply.status(201).send(ack);
  });
}
