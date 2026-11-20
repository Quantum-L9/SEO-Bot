/* L9_META
 * layer: module
 * role: build_intelligence_llm
 * status: active
 *
 * Direct DeepSeek calls for the build-intelligence producers. Other SEO-Bot
 * modules keep using the router through src/services/llm.ts.
 */

import { randomUUID } from "node:crypto";
import { getConfig } from "../core/config.js";
import type { LlmCallCounter } from "../services/llm.js";
import {
  isTruncatedFinish,
  LlmOutputTruncatedError,
  parseJsonFromLlm,
} from "../services/llm-parse.js";
import { LLM_PROVIDER_TIMEOUT_MS } from "../services/llm-provider-timeout.js";
import type { LlmRunRecorder, OperationAttempt } from "../services/llm-run-recorder.js";
import {
  clearSpendLedger,
  type DirectSpendCeilings,
  defaultSpendLedgerDir,
  reserveDirectSpend,
} from "./spend-ledger.js";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * Peak USD per 1M tokens. Matches the published DeepSeek peak table used by
 * Website-Bot so a reservation is an upper bound, never an under-count.
 */
const DEEPSEEK_PEAK_PRICING: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  "deepseek-flash": { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 },
};

export class ProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}
const OUTPUT_CEILING = 16_000;
/**
 * Upstream DeepSeek failure (timeout, network, or non-2xx). Not model output,
 * so callers must not spend a repair on it. It is a ProviderRequestError, so
 * callers that treat provider failures as terminal keep doing so.
 */
export class DeepSeekTransportError extends ProviderRequestError {
  readonly code = "DEEPSEEK_TRANSPORT_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekTransportError";
  }
}
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
  buildId?: string;
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

interface DeepSeekSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  ceilings: DirectSpendCeilings;
}

export function resetDeepSeekSpendForTests(): void {
  clearSpendLedger();
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function settingsFromParts(
  apiKey: string | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
  ceilings: DirectSpendCeilings,
): DeepSeekSettings {
  return {
    apiKey: apiKey?.trim() ?? "",
    model: model?.trim() || DEFAULT_MODEL,
    baseUrl: withoutTrailingSlashes(baseUrl?.trim() || DEFAULT_BASE_URL),
    ceilings,
  };
}

function reserveSpend(
  dir: string,
  args: BuildIntelligenceLlmArgs<unknown>,
  ceilings: DirectSpendCeilings,
  reservation: number,
  now: Date,
): void {
  const client = args.clientId;
  const scope = reserveDirectSpend({
    dir,
    clientId: client,
    buildId: args.buildId ?? "",
    usd: reservation,
    ceilings,
    now,
  });
  if (scope === "month") {
    throw new BudgetExhaustedError(
      `Budget exhausted for ${client}: reservation exceeds DEFAULT_CLIENT_MONTHLY_BUDGET; not dispatched`,
    );
  }
  if (scope === "week") {
    throw new BudgetExhaustedError(
      `Budget exhausted for ${client}: reservation exceeds DEFAULT_CLIENT_WEEKLY_CEILING; not dispatched`,
    );
  }
  if (scope === "global") {
    throw new BudgetExhaustedError(
      "Budget exhausted: reservation exceeds GLOBAL_MONTHLY_HARD_CEILING; not dispatched",
    );
  }
  if (scope === "day") {
    throw new BudgetExhaustedError(
      "Budget exhausted: reservation exceeds DAILY_SPEND_CAP; not dispatched",
    );
  }
}

function settingsFromConfig(): DeepSeekSettings {
  const config = getConfig();
  return settingsFromParts(
    config.DEEPSEEK_API_KEY,
    config.DEEPSEEK_MODEL,
    config.DEEPSEEK_BASE_URL,
    {
      monthlyUsd: config.DEFAULT_CLIENT_MONTHLY_BUDGET,
      weeklyUsd: config.DEFAULT_CLIENT_WEEKLY_CEILING,
      globalMonthlyUsd: config.GLOBAL_MONTHLY_HARD_CEILING,
      dailyUsd: config.DAILY_SPEND_CAP,
    },
  );
}

export function createDeepSeekBuildIntelligenceLlm(options?: {
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
  ceilings?: DirectSpendCeilings;
  ledgerDir?: string;
  now?: () => Date;
}): BuildIntelligenceLlm {
  const transport = options?.transport ?? ((url, init) => fetch(url, init));
  const ledgerDir = options?.ledgerDir ?? defaultSpendLedgerDir();
  const now = options?.now ?? (() => new Date());
  const settings = options?.env
    ? settingsFromParts(
        options.env.DEEPSEEK_API_KEY,
        options.env.DEEPSEEK_MODEL,
        options.env.DEEPSEEK_BASE_URL,
        options.ceilings ?? {
          monthlyUsd: 200,
          weeklyUsd: 100,
          globalMonthlyUsd: 2000,
        },
      )
    : settingsFromConfig();

  async function complete(
    operation: string,
    args: BuildIntelligenceLlmArgs<unknown>,
    userPrompt: string,
    maxOutputTokens: number,
    attempt: OperationAttempt,
  ): Promise<{ content: string; finishReason: string; outputTokens: number }> {
    if (!settings.apiKey) {
      throw new ProviderRequestError("Missing required LLM configuration: DEEPSEEK_API_KEY");
    }
    const pricing = DEEPSEEK_PEAK_PRICING[settings.model];
    if (!pricing) {
      throw new TaskValidationError(
        `DEEPSEEK_MODEL ${settings.model} has no verified pricing; not dispatched`,
      );
    }
    const inputBound =
      Buffer.byteLength(args.systemPrompt, "utf8") + Buffer.byteLength(userPrompt, "utf8");
    const reservation =
      (inputBound * pricing.inputPerMTok + maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
    reserveSpend(ledgerDir, args, settings.ceilings, reservation, now());
    let response: Response;
    try {
      response = await transport(`${settings.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            { role: "system", content: args.systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxOutputTokens,
          response_format: { type: "json_object" },
          stream: false,
        }),
        signal: AbortSignal.timeout(LLM_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeepSeekTransportError(
        `DeepSeek request failed for ${operation} (${error instanceof Error ? error.name : "error"})`,
      );
    }
    if (!response.ok) {
      throw new DeepSeekTransportError(`DeepSeek HTTP ${response.status} for ${operation}`);
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
          model: settings.model,
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
