/* L9_META
 * layer: test
 * role: test_fixture
 * status: active
 */

/**
 * The real build-intelligence DeepSeek client wired to a recorded/fake
 * transport: tests exercise request construction, the bounded-repair loop and
 * the truncation guard without a network or a paid call.
 */

import type { Mock } from "vitest";
import { vi } from "vitest";
import {
  type BuildIntelligenceLlm,
  createDeepSeekBuildIntelligenceLlm,
} from "../../../src/build-intelligence/deepseek-llm.js";

/** The parts of one chat-completions request a fake model answers from. */
export interface FakeChatRequest {
  system: string;
  user: string;
}

/** A completed (`finish_reason: "stop"`) chat-completions response carrying `reply` as JSON. */
export function completionResponse(reply: unknown): Response {
  const content = JSON.stringify(reply);
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { completion_tokens: Math.ceil(content.length / 4) },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * A DeepSeek client whose transport hands each request's system and user
 * prompts to `answer` and returns its value as the model's JSON reply.
 */
export function fakeDeepSeekLlm(
  answer: (request: FakeChatRequest) => unknown,
  ledgerDir: string,
): { llm: BuildIntelligenceLlm; transport: Mock } {
  const transport = vi.fn((_url: string, init: RequestInit): Promise<Response> => {
    if (typeof init.body !== "string") throw new TypeError("expected a JSON string request body");
    const body = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "";
    return Promise.resolve(completionResponse(answer({ system, user })));
  });
  const llm = createDeepSeekBuildIntelligenceLlm({
    env: { DEEPSEEK_API_KEY: "test-key" },
    transport,
    ledgerDir,
  });
  return { llm, transport };
}

/** The semantic validator's all-clear verdict. */
export const PASSING_VERDICT = {
  seo_blueprint_passed: true,
  contract_passed: true,
  unsupported_claims: [],
  failed_requirements: [],
};

/** True for a structured-content generation request (initial or repair). */
export function isGenerationRequest(request: FakeChatRequest): boolean {
  return request.system.includes("sole owner of final website prose");
}
