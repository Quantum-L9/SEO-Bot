import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Live-mutable config so tests can flip OPERATOR_API_KEY at request time.
const cfg = vi.hoisted(() => ({ current: {} as any }));
vi.mock("../../src/core/config.js", () => ({ getConfig: () => cfg.current }));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import {
  _resetRateLimiter,
  constantTimeEqual,
  isStrictRateLimited,
  parseAuthSecret,
  registerApiSecurity,
} from "../../src/api/security.js";

describe("parseAuthSecret", () => {
  it("parses a Bearer token", () => {
    expect(parseAuthSecret("Bearer abc123")).toBe("abc123");
  });
  it("parses the password portion of Basic auth", () => {
    const b64 = Buffer.from("operator:s3cret").toString("base64");
    expect(parseAuthSecret(`Basic ${b64}`)).toBe("s3cret");
  });
  it("returns null for missing or unsupported schemes", () => {
    expect(parseAuthSecret(undefined)).toBeNull();
    expect(parseAuthSecret("Weird xyz")).toBeNull();
    expect(parseAuthSecret("Bearer ")).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("isStrictRateLimited", () => {
  it("flags the expensive/abusable routes", () => {
    expect(isStrictRateLimited("/api/clients/register")).toBe(true);
    expect(isStrictRateLimited("/api/clients/abc-123/trigger")).toBe(true);
  });
  it("does not flag ordinary reads", () => {
    expect(isStrictRateLimited("/api/clients")).toBe(false);
    expect(isStrictRateLimited("/dashboard")).toBe(false);
  });
});

describe("operator auth hook", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetRateLimiter();
    cfg.current = { OPERATOR_API_KEY: "topsecret" };
    app = Fastify();
    registerApiSecurity(app);
    app.get("/health", async () => ({ ok: true }));
    app.get("/api/clients", async () => ({ clients: [] }));
    await app.ready();
  });

  it("allows /health without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a protected route with 401 and a WWW-Authenticate challenge", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients" });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("Basic");
  });

  it("accepts a correct Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients",
      headers: { authorization: "Bearer topsecret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts a correct Basic password", async () => {
    const b64 = Buffer.from("operator:topsecret").toString("base64");
    const res = await app.inject({
      method: "GET",
      url: "/api/clients",
      headers: { authorization: `Basic ${b64}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed (401) when OPERATOR_API_KEY is unset", async () => {
    cfg.current = {};
    const res = await app.inject({
      method: "GET",
      url: "/api/clients",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the machine secret (SEO_BOT_API_KEY) on build-intelligence routes", async () => {
    cfg.current = { OPERATOR_API_KEY: "topsecret", SEO_BOT_API_KEY: "machine-secret" };
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: { authorization: "Bearer machine-secret" },
    });
    // Route isn't registered in this test app (404), but the auth hook passed —
    // 401 would mean the machine secret was rejected.
    expect(res.statusCode).not.toBe(401);
  });

  it("keeps operator routes machine-key-only-exempt (SEO_BOT_API_KEY rejected)", async () => {
    cfg.current = { OPERATOR_API_KEY: "topsecret", SEO_BOT_API_KEY: "machine-secret" };
    const res = await app.inject({
      method: "GET",
      url: "/api/clients",
      headers: { authorization: "Bearer machine-secret" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects the operator key on build-intelligence routes (strict split, no dual authority)", async () => {
    cfg.current = { OPERATOR_API_KEY: "topsecret", SEO_BOT_API_KEY: "machine-secret" };
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: { authorization: "Bearer topsecret" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid machine key on build-intelligence routes (401)", async () => {
    cfg.current = { OPERATOR_API_KEY: "topsecret", SEO_BOT_API_KEY: "machine-secret" };
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: { authorization: "Bearer wrong-machine" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("fails closed (401) on build-intelligence when no machine key is configured", async () => {
    cfg.current = { OPERATOR_API_KEY: "topsecret" };
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: { authorization: "Bearer machine-secret" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("fails closed (401) on build-intelligence when neither key is configured", async () => {
    cfg.current = {};
    const res = await app.inject({
      method: "POST",
      url: "/api/build-intelligence/competitive-landscape",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── GAP-004: the rate limiter is classified but never behaviorally enforced ────
// The pre-existing tests only assert `isStrictRateLimited()` returns the right
// booleans — the entire onRequest hook could be deleted and they'd stay green.
// These drive requests across both thresholds and assert 429 + Retry-After,
// per-IP isolation, strict/default bucket independence, and window reset.
describe("rate limiter enforcement (GAP-004)", () => {
  let app: FastifyInstance;

  // trustProxy so X-Forwarded-For controls request.ip → distinct per-IP buckets.
  beforeEach(async () => {
    _resetRateLimiter();
    cfg.current = { OPERATOR_API_KEY: "topsecret" };
    app = Fastify({ trustProxy: true });
    registerApiSecurity(app);
    // Both routes are auth-exempt, so only the rate limiter gates them.
    app.get("/health", async () => ({ ok: true })); // default bucket (max 120)
    app.post("/api/clients/register", async () => ({ ok: true })); // strict bucket (max 10)
    await app.ready();
  });

  const strictReq = (ip: string) =>
    app.inject({
      method: "POST",
      url: "/api/clients/register",
      headers: { "x-forwarded-for": ip },
    });
  const defaultReq = (ip: string) =>
    app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": ip } });

  it("allows the 10th strict request and 429s the 11th", async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await strictReq("10.0.0.1");
      expect(res.statusCode).toBe(200);
    }
    const overflow = await strictReq("10.0.0.1");
    expect(overflow.statusCode).toBe(429);
    expect(overflow.json()).toEqual({ error: "rate limit exceeded" });
  });

  it("allows the 120th default request and 429s the 121st", async () => {
    for (let i = 1; i <= 120; i++) {
      const res = await defaultReq("10.0.0.2");
      expect(res.statusCode).toBe(200);
    }
    const overflow = await defaultReq("10.0.0.2");
    expect(overflow.statusCode).toBe(429);
  });

  it("emits a positive Retry-After header on the 429", async () => {
    for (let i = 1; i <= 10; i++) await strictReq("10.0.0.3");
    const overflow = await strictReq("10.0.0.3");
    expect(overflow.statusCode).toBe(429);
    const retryAfter = Number(overflow.headers["retry-after"]);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("isolates buckets per IP — one IP exhausting does not throttle another", async () => {
    for (let i = 1; i <= 10; i++) await strictReq("10.0.0.4");
    expect((await strictReq("10.0.0.4")).statusCode).toBe(429); // exhausted
    // A different IP still has its full quota.
    expect((await strictReq("10.0.0.5")).statusCode).toBe(200);
  });

  it("keeps strict and default buckets independent for the same IP", async () => {
    // Exhaust the strict bucket for this IP.
    for (let i = 1; i <= 10; i++) await strictReq("10.0.0.6");
    expect((await strictReq("10.0.0.6")).statusCode).toBe(429);
    // The default bucket for the SAME IP is untouched.
    expect((await defaultReq("10.0.0.6")).statusCode).toBe(200);
  });

  it("resets the window after it elapses", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      for (let i = 1; i <= 10; i++) await strictReq("10.0.0.7");
      expect((await strictReq("10.0.0.7")).statusCode).toBe(429);
      // Advance past the 60s window → the stale bucket is replaced, quota restored.
      vi.advanceTimersByTime(60_001);
      expect((await strictReq("10.0.0.7")).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
