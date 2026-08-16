import { sealWebsiteFactoryHandoff } from "@quantum-l9/bot-interop";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock, onConflictDoUpdateMock, returningMock, initClientMock } =
  vi.hoisted(() => {
    const returningMock = vi.fn();
    const onConflictDoUpdateMock = vi.fn(() => ({ returning: returningMock }));
    const valuesMock = vi.fn((..._args: unknown[]) => ({
      onConflictDoUpdate: onConflictDoUpdateMock,
    }));
    const insertMock = vi.fn(() => ({ values: valuesMock }));
    const initClientMock = vi.fn();
    return { insertMock, valuesMock, onConflictDoUpdateMock, returningMock, initClientMock };
  });

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({ insert: insertMock }),
  schema: { clients: { domain: "clients.domain", id: "clients.id" } },
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({ initClient: initClientMock }),
}));

import { registerClientRoutes } from "../../src/api/clients/register.js";

const KEY = "super-secret-key";
const AUTH = { authorization: `Bearer ${KEY}` };
const commit = "a".repeat(40);
const sourceDigest = "b".repeat(64);

function v3Payload() {
  return sealWebsiteFactoryHandoff({
    protocol: "l9.website-factory.handoff",
    schema_version: "3.0",
    contract_id: `example-co:build:${commit}`,
    emitted_at: "2026-07-20T12:00:00.000Z",
    client: {
      id: "example-co",
      domain: "https://www.Example.com/",
      name: "Example Co",
      industry: "roofing",
      state: "TX",
    },
    seo: { target_keywords: [{ keyword: "roof repair", priority: "high" }], competitor_urls: [] },
    site: {
      repository: {
        provider: "github",
        full_name: "Quantum-L9/example-site",
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
        deployment_url: "https://example.com",
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

function githubFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/Quantum-L9/example-site")) {
      return Response.json({ id: 123, full_name: "Quantum-L9/example-site" }, { status: 200 });
    }
    if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: commit } });
    if (url.includes("/contents/")) return Response.json({ sha: "file-sha" });
    return Response.json({}, { status: 500 });
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  returningMock.mockResolvedValue([{ id: "client-uuid-1" }]);
  initClientMock.mockResolvedValue(undefined);
  process.env.SEO_BOT_API_KEY = KEY;
  process.env.CLIENT_GITHUB_TOKEN = "token";
  app = Fastify();
  await registerClientRoutes(app, {
    fetchImpl: githubFetch(),
    env: { SEO_BOT_API_KEY: KEY, CLIENT_GITHUB_TOKEN: "token" } as NodeJS.ProcessEnv,
  });
  await app.ready();
});

afterEach(async () => {
  delete process.env.SEO_BOT_API_KEY;
  delete process.env.CLIENT_GITHUB_TOKEN;
  await app?.close();
});

describe("POST /api/clients/register", () => {
  it("registers a valid v3 handoff, normalizes the domain, and returns 201", async () => {
    const payload = v3Payload();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload,
      headers: { ...AUTH, "idempotency-key": payload.contract_id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ registered: true, client_id: "example-co" });
    expect(insertMock).toHaveBeenCalledOnce();
    expect(initClientMock).toHaveBeenCalledWith("client-uuid-1");

    const inserted = valuesMock.mock.calls[0][0] as {
      domain: string;
      config: { targetKeywords: unknown };
    };
    expect(inserted.domain).toBe("example.com");
    expect(inserted.config.targetKeywords).toEqual([{ keyword: "roof repair", priority: "high" }]);
    expect(onConflictDoUpdateMock).toHaveBeenCalledOnce();
  });

  it("rejects a non-v3 payload with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload: { schema_version: "2.0", domain: "example.com", name: "Example Co" },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().registered).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 409 when idempotency-key does not match contract_id", async () => {
    const payload = v3Payload();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload,
      headers: { ...AUTH, "idempotency-key": "mismatched-key" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ registered: false, error: "idempotency_key_contract_mismatch" });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/clients/register — API key gate (fail closed)", () => {
  it("rejects missing bearer with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload: v3Payload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects wrong bearer with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload: v3Payload(),
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a correct bearer token", async () => {
    const payload = v3Payload();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/register",
      payload,
      headers: { ...AUTH, "idempotency-key": payload.contract_id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ registered: true, client_id: "example-co" });
  });
});
