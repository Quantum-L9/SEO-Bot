import { sealWebsiteFactoryHandoff } from "@quantum-l9/bot-interop";
import { SQL } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const { valuesMock, onConflictDoUpdateMock, returningMock, initClientMock } = vi.hoisted(() => {
  const returningMock = vi.fn();
  const onConflictDoUpdateMock = vi.fn((..._args: unknown[]) => ({ returning: returningMock }));
  const valuesMock = vi.fn((..._args: unknown[]) => ({
    onConflictDoUpdate: onConflictDoUpdateMock,
  }));
  const initClientMock = vi.fn();
  return { valuesMock, onConflictDoUpdateMock, returningMock, initClientMock };
});

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: () => ({ values: valuesMock }) }),
  schema: { clients: { domain: "clients.domain", id: "clients.id", config: "clients.config" } },
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({ initClient: initClientMock }),
}));

import {
  BASELINE_MONITORING_JOBS,
  baselineJobId,
  type EnqueueMonitoringJob,
} from "../../src/api/clients/monitoring-enrollment.js";
import { registerClientRoutes } from "../../src/api/clients/register.js";

const KEY = "handoff-key";
const CLIENT_ROW_ID = "22222222-2222-2222-2222-222222222222";
const commit = "d".repeat(40);
const sourceDigest = "e".repeat(64);

/** The shape HandoffEmitterStage builds (Website-Bot buildWebsiteFactoryHandoffV3). */
function handoff(commitSha = commit) {
  return sealWebsiteFactoryHandoff({
    protocol: "l9.website-factory.handoff",
    schema_version: "3.0",
    contract_id: `quantumaipartners_com:build:${commitSha}`,
    emitted_at: "2026-11-16T12:00:00.000Z",
    client: {
      id: "quantumaipartners_com",
      domain: "https://quantumaipartners.com",
      name: "Quantum AI Partners",
      industry: "ai consulting",
    },
    seo: {
      target_keywords: [{ keyword: "ai consulting", priority: "high" }],
      competitor_urls: [],
    },
    site: {
      repository: {
        provider: "github",
        full_name: "Quantum-L9/quantumaipartners-site",
        repository_id: "987",
        branch: "main",
        commit_sha: commitSha,
        source_digest: sourceDigest,
        managed_manifest_path: ".l9/generated-manifest.json",
        editable_root: "src/pages",
        page_path_strategy: "directory-index-astro",
      },
      deployment: {
        provider: "vercel",
        project_id: "prj_q",
        deployment_id: "dpl_q",
        deployment_url: "https://quantumaipartners.com",
        state: "READY",
        requested_commit_sha: commitSha,
        observed_commit_sha: commitSha,
      },
      maintenance: {
        enabled: true,
        transport: "github-contents-api",
        github_credential_ref: "env://CLIENT_GITHUB_TOKEN",
        required_paths: [".l9/generated-manifest.json", "src/pages/index.astro"],
      },
    },
    proof: {
      receipt_id: "rcpt_q",
      receipt_status: "succeeded",
      source_digest: sourceDigest,
      dist_digest: "f".repeat(64),
      local_build_status: "passed",
      publication_status: "passed",
      deployment_status: "passed",
    },
  });
}

function readyGithub(commitSha = commit): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/Quantum-L9/quantumaipartners-site"))
      return Response.json({ id: 987, full_name: "Quantum-L9/quantumaipartners-site" });
    if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: commitSha } });
    if (url.includes("/contents/")) return Response.json({ sha: "file-sha" });
    return Response.json({}, { status: 500 });
  };
}

const unreachableGithub: typeof fetch = async () => Response.json({}, { status: 404 });

let app: FastifyInstance | undefined;

async function build(fetchImpl: typeof fetch, enqueueJob: EnqueueMonitoringJob) {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: CLIENT_ROW_ID }]);
  initClientMock.mockResolvedValue(undefined);
  app = Fastify();
  await registerClientRoutes(app, {
    fetchImpl,
    env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: "token" } as NodeJS.ProcessEnv,
    enqueueJob,
    now: () => new Date("2026-11-16T12:05:00.000Z"),
  });
  await app.ready();
  return app;
}

function post(server: FastifyInstance, payload: ReturnType<typeof handoff>) {
  return server.inject({
    method: "POST",
    url: "/api/clients/register",
    payload,
    headers: { authorization: `Bearer ${KEY}`, "idempotency-key": payload.contract_id },
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Website-Bot handoff → SEO-Bot monitoring enrollment", () => {
  it("queues one baseline run of every monitoring job on a verified handoff", async () => {
    const enqueue = vi.fn<EnqueueMonitoringJob>(async () => {});
    const server = await build(readyGithub(), enqueue);
    const payload = handoff();

    const res = await post(server, payload);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      client_id: "quantumaipartners_com",
      contract_id: payload.contract_id,
      verified_commit_sha: commit,
    });
    expect(enqueue.mock.calls.map(([name]) => name)).toEqual([...BASELINE_MONITORING_JOBS]);
    for (const [name, data, opts] of enqueue.mock.calls) {
      expect(data).toMatchObject({
        clientId: CLIENT_ROW_ID,
        clientDomain: "quantumaipartners.com",
      });
      expect(opts.jobId).toBe(baselineJobId(name, CLIENT_ROW_ID, payload.integrity.payload_digest));
      expect(opts.jobId).not.toContain(":");
    }
    // Monitoring only: the gated live-site write and outreach are never queued.
    const names = enqueue.mock.calls.map(([name]) => name);
    expect(names).not.toContain("serp:execute-surpass-plans");
    expect(names).not.toContain("links:process-outreach");
  });

  it("is idempotent on a re-handoff of the same release: same row key, same job ids", async () => {
    const enqueue = vi.fn<EnqueueMonitoringJob>(async () => {});
    const server = await build(readyGithub(), enqueue);
    const payload = handoff();

    const first = await post(server, payload);
    const second = await post(server, payload);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    // Both upserts target the domain unique key → one client row.
    for (const call of onConflictDoUpdateMock.mock.calls) {
      expect((call[0] as { target: unknown }).target).toBe("clients.domain");
    }
    const ids = enqueue.mock.calls.map(([, , opts]) => opts.jobId);
    expect(ids).toHaveLength(BASELINE_MONITORING_JOBS.length * 2);
    // BullMQ dedupes on job id, so the second handoff queues nothing new.
    expect(new Set(ids).size).toBe(BASELINE_MONITORING_JOBS.length);
  });

  it("earns a fresh baseline when a new release is handed off", async () => {
    const enqueue = vi.fn<EnqueueMonitoringJob>(async () => {});
    const otherCommit = "9".repeat(40);
    const server = await build(readyGithub(otherCommit), enqueue);
    await post(server, handoff(otherCommit));
    const oldIds = BASELINE_MONITORING_JOBS.map((job) =>
      baselineJobId(job, CLIENT_ROW_ID, handoff().integrity.payload_digest),
    );
    for (const [, , opts] of enqueue.mock.calls) expect(oldIds).not.toContain(opts.jobId);
  });

  it("merges config on re-handoff so operator-set keys survive", async () => {
    const server = await build(readyGithub(), async () => {});
    await post(server, handoff());
    const set = (onConflictDoUpdateMock.mock.calls[0][0] as { set: { config: unknown } }).set;
    expect(set.config).toBeInstanceOf(SQL);
    // The inserted row (first registration) still carries the plain handoff config.
    const values = valuesMock.mock.calls[0][0] as { config: { canonicalClientId: string } };
    expect(values.config.canonicalClientId).toBe("quantumaipartners_com");
  });

  it("still acknowledges a verified handoff when the queue is unavailable", async () => {
    const enqueue = vi.fn<EnqueueMonitoringJob>(async () => {
      throw new Error("redis down");
    });
    const server = await build(readyGithub(), enqueue);
    const res = await post(server, handoff());
    expect(res.statusCode).toBe(201);
    expect(enqueue).toHaveBeenCalledTimes(BASELINE_MONITORING_JOBS.length);
  });

  it("queues nothing when maintenance readiness fails (client stays inactive)", async () => {
    const enqueue = vi.fn<EnqueueMonitoringJob>(async () => {});
    const server = await build(unreachableGithub, enqueue);
    const res = await post(server, handoff());
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ registered: true, maintenance_ready: false });
    expect(enqueue).not.toHaveBeenCalled();
    expect((valuesMock.mock.calls[0][0] as { active: boolean }).active).toBe(false);
  });
});
