import { sealWebsiteFactoryHandoff } from "@quantum-l9/bot-interop";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock, returningMock, initClientMock } = vi.hoisted(() => {
  const returningMock = vi.fn();
  const onConflictDoUpdateMock = vi.fn(() => ({ returning: returningMock }));
  const valuesMock = vi.fn((..._args: unknown[]) => ({
    onConflictDoUpdate: onConflictDoUpdateMock,
  }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const initClientMock = vi.fn();
  return { insertMock, valuesMock, returningMock, initClientMock };
});

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { clients: { domain: "clients.domain" } },
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({ initClient: initClientMock }),
}));

import { registerClientRoutes } from "../../src/api/clients/register.js";

const KEY = "registration-key";
const AUTH = { authorization: `Bearer ${KEY}` };
const commit = "a".repeat(40);
const sourceDigest = "b".repeat(64);

function canonicalPayload() {
  return sealWebsiteFactoryHandoff({
    protocol: "l9.website-factory.handoff",
    schema_version: "3.0",
    contract_id: `canonical-client:build:${commit}`,
    emitted_at: "2026-07-20T12:00:00.000Z",
    client: {
      id: "canonical-client",
      domain: "https://www.Client.example.com/",
      name: "Client",
      industry: "services",
      state: "NC",
    },
    seo: { target_keywords: [{ keyword: "service nc", priority: "high" }], competitor_urls: [] },
    site: {
      repository: {
        provider: "github",
        full_name: "Quantum-L9/client-site",
        repository_id: "123",
        branch: "main",
        commit_sha: commit,
        source_digest: sourceDigest,
        managed_manifest_path: ".l9/generated-manifest.json",
        editable_root: "src/pages",
        page_path_strategy: "directory-index-astro",
      },
      deployment: {
        provider: "vercel",
        project_id: "prj_1",
        deployment_id: "dpl_1",
        deployment_url: "https://client.example.com",
        state: "READY",
        requested_commit_sha: commit,
        observed_commit_sha: commit,
      },
      maintenance: {
        enabled: true,
        transport: "github-contents-api",
        github_credential_ref: "env://CLIENT_GITHUB_TOKEN",
        required_paths: [".l9/generated-manifest.json", "src/pages/index.astro"],
      },
    },
    proof: {
      receipt_id: "rcpt_1",
      receipt_status: "succeeded",
      source_digest: sourceDigest,
      dist_digest: "c".repeat(64),
      local_build_status: "passed",
      publication_status: "passed",
      deployment_status: "passed",
    },
  });
}

function githubFetch(options: { repoStatus?: number } = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/Quantum-L9/client-site"))
      return Response.json(
        { id: 123, full_name: "Quantum-L9/client-site" },
        { status: options.repoStatus ?? 200 },
      );
    if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: commit } });
    if (url.includes("/contents/")) return Response.json({ sha: "file-sha" });
    return Response.json({}, { status: 500 });
  };
}

let app: FastifyInstance;
async function build(fetchImpl: typeof fetch) {
  app = Fastify();
  await registerClientRoutes(app, {
    fetchImpl,
    env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: "token" } as NodeJS.ProcessEnv,
    now: () => new Date("2026-07-20T12:01:00.000Z"),
  });
  await app.ready();
}

beforeEach(() => {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: "11111111-1111-1111-1111-111111111111" }]);
  initClientMock.mockResolvedValue(undefined);
});
afterEach(async () => {
  await app?.close();
});

describe("POST /api/clients/register canonical v3", () => {
  it("returns the exact digest-bound acknowledgement Website-Bot verifies", async () => {
    await build(githubFetch());
    const payload = canonicalPayload();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload,
      headers: { ...AUTH, "idempotency-key": payload.contract_id },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      schema: "seo-bot.website-factory-registration-ack/v1",
      registered: true,
      maintenance_ready: true,
      client_id: payload.client.id,
      contract_id: payload.contract_id,
      contract_digest: payload.integrity.payload_digest,
      release_receipt_id: payload.proof.receipt_id,
      verified_repository: payload.site.repository.full_name,
      verified_branch: payload.site.repository.branch,
      verified_commit_sha: commit,
    });
    expect(initClientMock).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    const inserted = valuesMock.mock.calls[0][0] as any;
    expect(inserted.config.canonicalClientId).toBe("canonical-client");
    expect(inserted.config.site_deployment.status).toBe("ready");
  });

  it("registers inactive when readiness fails", async () => {
    await build(githubFetch({ repoStatus: 404 }));
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload: canonicalPayload(),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().error).toBe("REPOSITORY_NOT_FOUND");
    expect((valuesMock.mock.calls[0][0] as any).active).toBe(false);
    expect(initClientMock).not.toHaveBeenCalled();
  });

  it("rejects tampering before database mutation", async () => {
    await build(githubFetch());
    const payload = canonicalPayload();
    const tampered = { ...payload, client: { ...payload.client, name: "Renamed Co" } };
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload: tampered,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toContain("digest");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
