import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadInfisicalSecrets = vi.hoisted(() => vi.fn());

vi.mock("@quantum-l9/infisical-config", () => ({
  loadSecrets: loadInfisicalSecrets,
}));

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { hydrateSecretsIfConfigured, loadSecrets } from "../../src/core/secrets.js";

const BOOTSTRAP_KEYS = [
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_PROJECT_ID",
] as const;

beforeEach(() => {
  loadInfisicalSecrets.mockReset();
  for (const key of BOOTSTRAP_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of BOOTSTRAP_KEYS) {
    delete process.env[key];
  }
});

describe("loadSecrets (package adapter)", () => {
  it("delegates with logger and overwrite:false", async () => {
    loadInfisicalSecrets.mockResolvedValue({ loaded: true, injected: 2, source: "infisical" });
    const result = await loadSecrets();
    expect(result).toEqual({ loaded: true, injected: 2, source: "infisical" });
    expect(loadInfisicalSecrets).toHaveBeenCalledTimes(1);
    const arg = loadInfisicalSecrets.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ logger: expect.any(Object), overwrite: false }));
  });

  it("propagates package failures", async () => {
    loadInfisicalSecrets.mockRejectedValue(new Error("INFISICAL_REQUIRED=true boom"));
    await expect(loadSecrets()).rejects.toThrow(/INFISICAL_REQUIRED/);
  });
});

describe("hydrateSecretsIfConfigured", () => {
  it("reports process_env_only when bootstrap is absent", async () => {
    loadInfisicalSecrets.mockResolvedValue({ loaded: false, injected: 0, source: "none" });
    const meta = await hydrateSecretsIfConfigured();
    expect(meta.bootstrap_present).toBe(false);
    expect(meta.source_mode).toBe("process_env_only");
  });

  it("reports infisical_hydrated when bootstrap present and load succeeds", async () => {
    process.env.INFISICAL_CLIENT_ID = "id";
    process.env.INFISICAL_CLIENT_SECRET = "secret";
    process.env.INFISICAL_PROJECT_ID = "proj";
    loadInfisicalSecrets.mockResolvedValue({ loaded: true, injected: 3, source: "infisical" });
    const meta = await hydrateSecretsIfConfigured();
    expect(meta.bootstrap_present).toBe(true);
    expect(meta.source_mode).toBe("infisical_hydrated");
  });

  it("reports infisical_unavailable when bootstrap present but load soft-fails", async () => {
    process.env.INFISICAL_CLIENT_ID = "id";
    process.env.INFISICAL_CLIENT_SECRET = "secret";
    process.env.INFISICAL_PROJECT_ID = "proj";
    loadInfisicalSecrets.mockResolvedValue({ loaded: false, injected: 0, source: "none" });
    const meta = await hydrateSecretsIfConfigured();
    expect(meta.bootstrap_present).toBe(true);
    expect(meta.source_mode).toBe("infisical_unavailable");
  });
});
