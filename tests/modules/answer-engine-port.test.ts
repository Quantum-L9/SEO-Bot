/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { post } }));
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ PERPLEXITY_API_KEY: "pk-test" }),
}));

import {
  getAnswerEnginePort,
  PerplexityAnswerEnginePort,
} from "../../src/modules/aeo-geo/answer-engine-port.js";
import { LlmRunRecorder } from "../../src/services/llm-run-recorder.js";

beforeEach(() => post.mockReset());

describe("AnswerEngineObservationPort (Perplexity)", () => {
  it("confines the direct provider call and returns content + citations", async () => {
    post.mockResolvedValue({
      data: {
        choices: [{ message: { content: "answer" } }],
        citations: ["https://alpha.com", "https://beta.com"],
      },
    });
    const port = getAnswerEnginePort("perplexity");
    expect(port.engine).toBe("perplexity");
    const observation = await port.observe("who does metal roofing?");
    expect(observation.content).toBe("answer");
    expect(observation.citations).toEqual(["https://alpha.com", "https://beta.com"]);
    // The provider host is only ever reached from inside this port.
    expect(post).toHaveBeenCalledWith(
      "https://api.perplexity.ai/chat/completions",
      expect.objectContaining({ return_citations: true }),
      expect.objectContaining({ headers: { Authorization: "Bearer pk-test" } }),
    );
  });

  it("returns a singleton port instance", () => {
    expect(getAnswerEnginePort("perplexity")).toBe(getAnswerEnginePort("perplexity"));
    expect(getAnswerEnginePort("perplexity")).toBeInstanceOf(PerplexityAnswerEnginePort);
  });
});

/**
 * `direct_provider_bypass_count` is the number of bypasses that HAPPENED. This
 * port is SEO-Bot's only sanctioned site where a provider is reached outside
 * @quantum-l9/llm-router, so a run's count is non-zero exactly when this port
 * ran during it — and zero because it did not, never because zero is expected.
 */
describe("AnswerEngineObservationPort — direct provider bypass is recorded", () => {
  it("publishes one bypass event per observation to the open run", async () => {
    post.mockResolvedValue({ data: { choices: [{ message: { content: "a" } }], citations: [] } });
    const recorder = new LlmRunRecorder("seo-run:test");
    await getAnswerEnginePort("perplexity").observe("q1");
    await getAnswerEnginePort("perplexity").observe("q2");
    recorder.close();

    const bypasses = recorder.snapshot().direct_provider_bypasses;
    expect(bypasses).toHaveLength(2);
    expect(bypasses[0]).toMatchObject({
      site: "aeo-geo:answer-engine-observation",
      engine: "perplexity",
    });
    expect(bypasses[0]!.rationale).toBeTruthy();
  });

  it("records nothing for a run during which the port never ran", async () => {
    const recorder = new LlmRunRecorder("seo-run:quiet");
    recorder.close();
    expect(recorder.snapshot().direct_provider_bypasses).toEqual([]);
  });

  it("records the bypass BEFORE the provider request leaves, not on success", async () => {
    // The bypass is the event, not its outcome. Recording it ahead of the
    // request means a provider call that later fails is still counted as the
    // bypass it was.
    const recorder = new LlmRunRecorder("seo-run:test");
    let bypassesWhenRequestIssued = -1;
    post.mockImplementation(async () => {
      bypassesWhenRequestIssued = recorder.snapshot().direct_provider_bypasses.length;
      return { data: { choices: [{ message: { content: "a" } }], citations: [] } };
    });
    await getAnswerEnginePort("perplexity").observe("q");
    recorder.close();
    expect(bypassesWhenRequestIssued).toBe(1);
  });
});
