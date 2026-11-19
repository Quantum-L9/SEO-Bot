/* L9_META
 * layer: module
 * role: build_intelligence_llm
 * status: active
 *
 * Direct DeepSeek calls for the build-intelligence producers. Other SEO-Bot
 * modules keep using the router through src/services/llm.ts.
 */

import { randomUUID } from "node:crypto";
import type { LlmCallCounter } from "../services/llm.js";
import {
  isTruncatedFinish,
  LlmOutputTruncatedError,
  parseJsonFromLlm,
} from "../services/llm-parse.js";
import type { LlmRunRecorder, OperationAttempt } from "../services/llm-run-recorder.js";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const OUTPUT_CEILING = 16_000;
const DEFAULT_OUTPUT_TOKENS: Record<string, number> = {
  SEO_CONTENT_BLUEPRINT: 5_000,
  STRUCTURED_CONTENT_GENERATION: 12_000,
  CONTENT_VALIDATION: 2_500,
};

export interface BuildIntelligenceLlmArgs<T> {
  clientId: string;
  module: string;
  purpose: string;
  systemPrompt: string;
  userPrompt: string;
  validate: (value: unknown) => T;
  schemaRepairAttempts?: 0 | 1;
  callCounter?: LlmCallCounter;
  recorder?: LlmRunRecorder;
  expectedOutputTokens?: number;
}

export interface BuildIntelligenceLlm {
  strategizeJson<T>(args: BuildIntelligenceLlmArgs<T>): Promise<T>;
  executePolicyJson<T>(operation: string, args: BuildIntelligenceLlmArgs<T>): Promise<T>;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

interface Completion {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  usage?: { completion_tokens?: number };
}

export function createDeepSeekBuildIntelligenceLlm(options?: {
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}): BuildIntelligenceLlm {
  const env = options?.env ?? process.env;
  const transport = options?.transport ?? ((url, init) => fetch(url, init));

  async function complete(
    operation: string,
    args: BuildIntelligenceLlmArgs<unknown>,
    userPrompt: string,
    maxOutputTokens: number,
    attempt: OperationAttempt,
  ): Promise<{ content: string; finishReason: string; outputTokens: number }> {
    const apiKey = env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing required LLM configuration: DEEPSEEK_API_KEY");
    const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
    const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await transport(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: args.systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`DeepSeek HTTP ${response.status} for ${operation}`);
    }
    const completion = (await response.json()) as Completion;
    const choice = completion.choices?.[0];
    const content = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason ?? "missing";
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    if (args.callCounter) args.callCounter.value += 1;
    args.recorder?.attributeOperationCall({
      operation,
      purpose: args.purpose,
      attempt,
      descriptorRequiresSearch: false,
      decisions: [
        {
          taskId: randomUUID(),
          provider: DEEPSEEK_PROVIDER,
          model,
          searchRequired: false,
          searchPolicySource: "EXPLICIT",
          outcome: "SUCCESS",
        } as never,
      ],
      response: { provider: DEEPSEEK_PROVIDER },
    });
    if (isTruncatedFinish(finishReason, outputTokens, maxOutputTokens)) {
      throw new LlmOutputTruncatedError({
        operation,
        purpose: args.purpose,
        attempt,
        maxOutputTokens,
        outputTokens,
        finishReason,
        responseLength: content.length,
      });
    }
    return { content, finishReason, outputTokens };
  }

  const client: BuildIntelligenceLlm = {
    async strategizeJson(args) {
      return client.executePolicyJson("SEO_CONTENT_BLUEPRINT", args);
    },
    async executePolicyJson(operation, args) {
      const repairAttempts = args.schemaRepairAttempts ?? 1;
      const requested = args.expectedOutputTokens ?? DEFAULT_OUTPUT_TOKENS[operation] ?? 2_500;
      const maxOutputTokens = Math.min(OUTPUT_CEILING, Math.max(1, requested));
      const first = await complete(operation, args, args.userPrompt, maxOutputTokens, "initial");
      try {
        return args.validate(parseJsonFromLlm(first.content));
      } catch (error) {
        if (repairAttempts === 0 || error instanceof LlmOutputTruncatedError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const repairPrompt = `${args.userPrompt}\n\n---\nYour previous response was rejected: ${reason}\nRespond again with ONLY a single valid JSON value. No prose, no markdown fences.`;
        const second = await complete(operation, args, repairPrompt, maxOutputTokens, "repair");
        return args.validate(parseJsonFromLlm(second.content));
      }
    },
  };
  return client;
}

let singleton: BuildIntelligenceLlm | undefined;

export function getDeepSeekBuildIntelligenceLlm(): BuildIntelligenceLlm {
  singleton ??= createDeepSeekBuildIntelligenceLlm();
  return singleton;
}
