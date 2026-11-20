/* L9_META
 * layer: test
 * role: api_route_test
 * status: active
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("build-intelligence API without llm-router", () => {
  it("registers the preflight route when the router package is unresolved", async () => {
    vi.resetModules();
    vi.doMock("@quantum-l9/llm-router", () => {
      throw new Error("llm-router unresolved");
    });
    const { registerBuildIntelligenceRoutes } = await import("../../src/api/build-intelligence.js");
    const app = Fastify({ logger: false });
    await registerBuildIntelligenceRoutes(app);
    expect(app.printRoutes()).toContain("preflight");
    await app.close();
  });
});
