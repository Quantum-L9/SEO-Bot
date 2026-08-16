import { sealWebsiteFactoryHandoff, type WebsiteFactoryHandoffV3 } from "@quantum-l9/bot-interop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMaintenanceReadiness } from "../../src/services/maintenance-readiness.js";

const commit = "a".repeat(40);
const sourceDigest = "b".repeat(64);

function contract(): WebsiteFactoryHandoffV3 {
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
        deployment_url: "https://example.com",
        state: "READY",
        requested_commit_sha: commit,
        observed_commit_sha: commit,
      },
      maintenance: {
        enabled: true,
        transport: "github-contents-api",
        github_credential_ref: "env://CLIENT_GITHUB_TOKEN",
        vercel_deploy_hook_ref: "env://CLIENT_VERCEL_HOOK",
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

function githubFetch(
  options: { repoStatus?: number; head?: string; missingPath?: string } = {},
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/Quantum-L9/client-site")) {
      return Response.json(
        { id: 123, full_name: "Quantum-L9/client-site" },
        { status: options.repoStatus ?? 200 },
      );
    }
    if (url.includes("/git/ref/heads/main"))
      return Response.json({ object: { sha: options.head ?? commit } });
    if (options.missingPath && url.includes(options.missingPath))
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (url.includes("/contents/")) return Response.json({ sha: "file-sha" });
    return Response.json({ message: "unexpected" }, { status: 500 });
  };
}

describe("verifyMaintenanceReadiness", () => {
  it("proves repository, branch, manifest, editable page, and secret refs", async () => {
    const result = await verifyMaintenanceReadiness(contract(), {
      fetchImpl: githubFetch(),
      env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      now: () => new Date("2026-07-20T12:01:00.000Z"),
    });
    expect(result.ready).toBe(true);
    expect(result.verifiedCommitSha).toBe(commit);
    expect(result.probes.every((probe) => probe.ok)).toBe(true);
  });

  it("rejects a nonexistent repository before persistence", async () => {
    await expect(
      verifyMaintenanceReadiness(contract(), {
        fetchImpl: githubFetch({ repoStatus: 404 }),
        env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });

  it("rejects a repository id mismatch even when owner/name resolves", async () => {
    const payload = contract();
    payload.site.repository.repository_id = "999";
    await expect(
      verifyMaintenanceReadiness(payload, {
        fetchImpl: githubFetch(),
        env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_ID_MISMATCH" });
  });

  it("rejects branch drift from the deployed commit", async () => {
    await expect(
      verifyMaintenanceReadiness(contract(), {
        fetchImpl: githubFetch({ head: "d".repeat(40) }),
        env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      }),
    ).rejects.toMatchObject({ code: "COMMIT_MISMATCH" });
  });

  it("probes every declared required path, not only the two canonical anchors", async () => {
    const payload = contract();
    payload.site.maintenance.required_paths.push("src/pages/services/index.astro");
    await expect(
      verifyMaintenanceReadiness(payload, {
        fetchImpl: githubFetch({ missingPath: "src/pages/services/index.astro" }),
        env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      }),
    ).rejects.toMatchObject({ code: "REQUIRED_PATH_MISSING" });
  });

  it("rejects a missing editable Astro page", async () => {
    await expect(
      verifyMaintenanceReadiness(contract(), {
        fetchImpl: githubFetch({ missingPath: "src/pages/index.astro" }),
        env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
      }),
    ).rejects.toMatchObject({ code: "REQUIRED_PATH_MISSING" });
  });

  it("fails closed when the github credential ref is unresolved", async () => {
    await expect(
      verifyMaintenanceReadiness(contract(), {
        fetchImpl: githubFetch(),
        env: {},
      }),
    ).rejects.toMatchObject({ code: "SECRET_UNRESOLVED" });
  });
});

// ── GAP-002: assert the HTTP transport envelope, not just semantic outcomes ────
// The existing tests only choose a mock response by URL and never inspect the
// request init. A regression that dropped the Authorization header, omitted the
// API-version header, switched to POST, or removed the AbortSignal.timeout would
// still pass them. These tests capture the second fetch argument and the timeout.
describe("verifyMaintenanceReadiness — GitHub request envelope (GAP-002)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A fetch that records (url, init) for every call and returns the same happy
   *  responses as githubFetch so verification reaches all probe requests. */
  function capturingFetch(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/Quantum-L9/client-site")) {
        return Response.json({ id: 123, full_name: "Quantum-L9/client-site" }, { status: 200 });
      }
      if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: commit } });
      if (url.includes("/contents/")) return Response.json({ sha: "file-sha" });
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;
  }

  it("sends GET with Bearer auth, the GitHub Accept + API-version headers on every probe", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await verifyMaintenanceReadiness(contract(), {
      fetchImpl: capturingFetch(calls),
      env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
    });

    // repo + branch + 2 required paths = 4 GitHub calls, all identically enveloped.
    expect(calls.length).toBe(4);
    for (const { init } of calls) {
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token");
      expect(headers.Accept).toBe("application/vnd.github+json");
      expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    }
  });

  it("bounds every probe with a 15s AbortSignal.timeout forwarded into fetch", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => realTimeout(ms));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await verifyMaintenanceReadiness(contract(), {
      fetchImpl: capturingFetch(calls),
      env: { CLIENT_GITHUB_TOKEN: "token", CLIENT_VERCEL_HOOK: "https://hook.example.com" },
    });

    // Every probe requested a 15_000ms timeout...
    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 15_000)).toBe(true);
    // ...and the resulting signal was actually attached to each fetch call.
    for (const { init } of calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
