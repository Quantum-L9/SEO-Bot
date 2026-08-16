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
