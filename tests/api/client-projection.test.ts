/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

/**
 * Testing contract §10 — the operator client surface serves no credential.
 *
 * `tests/api/index.test.ts` already pins the COLUMN allow-list: the routes never
 * select `posthog_api_key`. That is the whole guarantee a column allow-list can
 * give, and it stops one column short of the actual exposure — `config` is JSONB,
 * it is IN the allow-list because operators need it, and it carries
 * `site_deployment.githubToken` (a raw GitHub PAT on the pre-v2 registration
 * path) and `site_deployment.vercelDeployHook` (a URL that redeploys a client's
 * site for anyone holding it).
 *
 * So this file tests the inside of the blob, and it tests it twice: once over
 * `redactClientConfig` directly, and once end-to-end through `app.inject`, where
 * the assertion is made against the SERIALIZED BODY rather than against the
 * parsed object. A leak through a path the deny-list never saw would still be a
 * substring of the response, and the body-level check is the one that catches it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ queue: [] as unknown[], selectArgs: [] as unknown[] }));

vi.mock("../../src/core/database/index.js", () => {
  const makeBuilder = (result: unknown) => {
    const p = Promise.resolve(result) as Promise<unknown> & Record<string, () => unknown>;
    for (const m of ["from", "where", "orderBy", "limit"]) {
      p[m] = () => p;
    }
    return p;
  };
  const db = {
    select: (cols?: unknown) => {
      dbState.selectArgs.push(cols);
      return makeBuilder(dbState.queue.shift() ?? []);
    },
    execute: () => Promise.resolve([]),
  };
  return {
    getDb: () => db,
    schema: {
      clients: Object.fromEntries(
        [
          "id",
          "name",
          "domain",
          "industry",
          "city",
          "state",
          "country",
          "config",
          "active",
          "createdAt",
          "updatedAt",
          "posthogApiKey",
          "posthogProjectId",
        ].map((k) => [k, `clients.${k}`]),
      ),
      serpRankings: {},
      webVitals: {},
      pageEngagement: {},
      linkProspects: {},
      aeoCitations: {},
      actionOutcomes: {},
    },
  };
});

vi.mock("../../src/core/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/scheduler.js")>()),
  getScheduler: () => ({ addJob: vi.fn(), isRunning: () => true }),
}));
vi.mock("../../src/services/llm.js", () => ({
  getLlmService: () => ({ getDailySpend: vi.fn().mockResolvedValue(0), initClient: vi.fn() }),
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({
    TRUST_PROXY: false,
    OPERATOR_API_KEY: "op-key",
    DASHBOARD_ALLOWED_ORIGINS: undefined,
  }),
}));

import { buildApiServer } from "../../src/api/index.js";
import {
  assertNoCredentialLeak,
  CLIENT_CONFIG_SECRET_KEYS,
  REDACTED,
  redactClientConfig,
} from "../../src/api/client-projection.js";

const AUTH = { authorization: "Bearer op-key" };

/** A live GitHub PAT and a live deploy hook, as a pre-v2 client actually stores them. */
const GITHUB_TOKEN = "ghp_liveTokenValueThatMustNeverBeServed";
const DEPLOY_HOOK = "https://api.vercel.com/v1/integrations/deploy/prj_secret/HOOKSECRET";

const clientRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Roofing",
  domain: "acme.com",
  industry: "roofing",
  active: true,
  config: {
    targetKeywords: [{ keyword: "roof repair", priority: 1 }],
    competitors: [{ domain: "rival.com" }],
    site_deployment: {
      githubToken: GITHUB_TOKEN,
      vercelDeployHook: DEPLOY_HOOK,
      websiteBotRepo: "Quantum-L9/acme-site",
      sourceBranch: "main",
      status: "ready",
    },
  },
};

describe("redactClientConfig", () => {
  it("replaces a stored GitHub token and deploy hook with a marker", () => {
    const out = redactClientConfig(clientRow.config) as Record<string, never>;
    const sd = (out as { site_deployment: Record<string, unknown> }).site_deployment;
    expect(sd.githubToken).toBe(REDACTED);
    expect(sd.vercelDeployHook).toBe(REDACTED);
  });

  it("keeps the non-secret configuration the endpoint exists to show", () => {
    const out = redactClientConfig(clientRow.config) as {
      targetKeywords: unknown;
      competitors: unknown;
      site_deployment: Record<string, unknown>;
    };
    expect(out.targetKeywords).toEqual(clientRow.config.targetKeywords);
    expect(out.competitors).toEqual(clientRow.config.competitors);
    // The target repo and branch are configuration, not credentials: an operator
    // diagnosing a client writing to the wrong repo needs to see which repo.
    expect(out.site_deployment.websiteBotRepo).toBe("Quantum-L9/acme-site");
    expect(out.site_deployment.sourceBranch).toBe("main");
    expect(out.site_deployment.status).toBe("ready");
  });

  it("distinguishes a configured credential from an absent one", () => {
    // `siteConfigFromClient` forces dry-run on a blank token, so "blank" and
    // "set" are operationally different states. Redacting both to the same
    // marker would hide the difference on the endpoint that has to show it.
    const out = redactClientConfig({
      site_deployment: { githubToken: "", vercelDeployHook: DEPLOY_HOOK },
    }) as { site_deployment: Record<string, unknown> };
    expect(out.site_deployment.githubToken).toBe("");
    expect(out.site_deployment.vercelDeployHook).toBe(REDACTED);
  });

  it("redacts at any depth, not only where the writer puts the block today", () => {
    const out = redactClientConfig({
      environments: { staging: { site_deployment: { githubToken: GITHUB_TOKEN } } },
    });
    expect(JSON.stringify(out)).not.toContain(GITHUB_TOKEN);
  });

  it("walks arrays as well as objects", () => {
    const out = redactClientConfig({ targets: [{ githubToken: GITHUB_TOKEN }] });
    expect(JSON.stringify(out)).not.toContain(GITHUB_TOKEN);
  });

  it("matches the key case-insensitively in either spelling", () => {
    const out = redactClientConfig({
      github_token: GITHUB_TOKEN,
      GitHubToken: GITHUB_TOKEN,
      vercel_deploy_hook: DEPLOY_HOOK,
    });
    expect(JSON.stringify(out)).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(out)).not.toContain(DEPLOY_HOOK);
  });

  it("leaves the env:// reference fields alone — they name a secret, they are not one", () => {
    const out = redactClientConfig({
      site_deployment: {
        schemaVersion: "2.0",
        githubCredentialRef: "env://GITHUB_TOKEN",
        vercelDeployHookRef: "env://VERCEL_DEPLOY_HOOK",
      },
    }) as { site_deployment: Record<string, unknown> };
    // An operator diagnosing a client stuck at `unverified` needs to see WHICH
    // reference failed to resolve; the reference is not the credential.
    expect(out.site_deployment.githubCredentialRef).toBe("env://GITHUB_TOKEN");
    expect(out.site_deployment.vercelDeployHookRef).toBe("env://VERCEL_DEPLOY_HOOK");
  });

  it("passes scalars, null and empty input through unchanged", () => {
    expect(redactClientConfig(null)).toBeNull();
    expect(redactClientConfig(undefined)).toBeUndefined();
    expect(redactClientConfig(42)).toBe(42);
    expect(redactClientConfig({})).toEqual({});
  });
});

describe("the secret-key set tracks the real config type", () => {
  // Mirrors the evidence-pack contract: a deny-list is only as good as its
  // coverage of the fields that actually hold secrets, so the set is checked
  // against the DECLARATION rather than against a copy of it. A new credential
  // field on ClientSiteDeploymentConfig fails here until it is classified.
  it("covers every credential-shaped field ClientSiteDeploymentConfig declares", () => {
    const types = readFileSync(join(process.cwd(), "src/types/index.ts"), "utf8");
    const block = types.slice(types.indexOf("export interface ClientSiteDeploymentConfig"));
    const body = block.slice(0, block.indexOf("\n}"));
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);

    expect(fields.length).toBeGreaterThan(0);
    const credentialShaped = fields.filter(
      (field) => /token|secret|password|hook|credential|key/i.test(field) && !/Ref$/.test(field),
    );
    // Guards the guard: if the regex ever matches nothing, this test would pass
    // vacuously while covering no field at all.
    expect(credentialShaped).toContain("githubToken");
    expect(credentialShaped).toContain("vercelDeployHook");
    for (const field of credentialShaped) {
      expect(CLIENT_CONFIG_SECRET_KEYS.has(field.toLowerCase()), field).toBe(true);
    }
  });

  it("lists both the camel and the snake spelling of every key", () => {
    for (const key of CLIENT_CONFIG_SECRET_KEYS) {
      const snake = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const camel = key.replace(/_(\w)/g, (_, c) => c.toUpperCase()).toLowerCase();
      expect(CLIENT_CONFIG_SECRET_KEYS.has(snake), `${key} → ${snake}`).toBe(true);
      expect(CLIENT_CONFIG_SECRET_KEYS.has(camel), `${key} → ${camel}`).toBe(true);
    }
  });
});

describe("assertNoCredentialLeak", () => {
  it("throws when a secret value survives into the payload", () => {
    expect(() => assertNoCredentialLeak({ a: { b: GITHUB_TOKEN } }, [GITHUB_TOKEN])).toThrow(
      /leaked a credential/,
    );
  });

  it("accepts a payload where the value was redacted", () => {
    expect(() => assertNoCredentialLeak({ a: REDACTED }, [GITHUB_TOKEN])).not.toThrow();
  });

  it("does not treat a blank or marker secret as something to search for", () => {
    // Every unconfigured client stores "" — searching for it would match any
    // payload at all and turn the assertion into a permanent failure.
    expect(() => assertNoCredentialLeak({ anything: "x" }, ["", REDACTED])).not.toThrow();
  });
});

describe("the routes serve no credential (contract §10)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    dbState.queue = [];
    dbState.selectArgs = [];
    app = await buildApiServer();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("GET /api/clients serves the config without the token or the hook", async () => {
    dbState.queue = [[clientRow]];
    const res = await app.inject({ method: "GET", url: "/api/clients", headers: AUTH });

    expect(res.statusCode).toBe(200);
    // Asserted on the RAW BODY: a leak through an unanticipated path is still a
    // substring of the response even when the parsed shape looks clean.
    expect(res.body).not.toContain(GITHUB_TOKEN);
    expect(res.body).not.toContain(DEPLOY_HOOK);
    assertNoCredentialLeak(res.json(), [GITHUB_TOKEN, DEPLOY_HOOK]);

    const [client] = res.json().clients;
    expect(client.config.site_deployment.githubToken).toBe(REDACTED);
    expect(client.config.targetKeywords).toEqual(clientRow.config.targetKeywords);
  });

  it("GET /api/clients/:id serves the config without the token or the hook", async () => {
    dbState.queue = [[clientRow], [], [], [], [], []];
    const res = await app.inject({
      method: "GET",
      url: `/api/clients/${clientRow.id}`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(GITHUB_TOKEN);
    expect(res.body).not.toContain(DEPLOY_HOOK);
    assertNoCredentialLeak(res.json(), [GITHUB_TOKEN, DEPLOY_HOOK]);
    expect(res.json().client.config.site_deployment.vercelDeployHook).toBe(REDACTED);
  });

  it("still serves neither PostHog column, which the column allow-list covers", async () => {
    dbState.queue = [[clientRow]];
    const res = await app.inject({ method: "GET", url: "/api/clients", headers: AUTH });
    expect(res.body).not.toContain("posthogApiKey");
    expect(res.body).not.toContain("posthogProjectId");
  });
});
