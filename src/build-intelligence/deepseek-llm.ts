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
import type {
  LlmRunRecorder,
  OperationAttempt,
  ProviderAttemptOutcome,
  ProviderAttemptReceipt,
} from "../services/llm-run-recorder.js";
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

/**
 * DeepSeek pricing basis recorded on every attempt receipt: cost is computed
 * from the provider-reported usage at the peak table above, so it is an upper
 * bound that anyone can recompute from the receipt's own token counts.
 */
export const DEEPSEEK_PRICING_BASIS = "deepseek-peak-per-mtok";

/**
 * Build-intelligence operations this client serves. Each one has exactly one
 * typed provider policy below; an operation without a policy is refused before
 * dispatch.
 */
export type BuildIntelligenceOperation =
  | "SEO_CONTENT_BLUEPRINT"
  | "STRUCTURED_CONTENT_GENERATION"
  | "CONTENT_VALIDATION";

/**
 * Per-operation provider policy. Every DeepSeek request states its thinking
 * mode explicitly from here. Nothing relies on the provider default, which
 * enables thinking at reasoning_effort high when the request sets neither
 * `thinking` nor `reasoning_effort`. Reasoning tokens then consume the output
 * budget of a structured reply.
 *
 * DeepSeek chat-completions request fields used (api-docs.deepseek.com,
 * create-chat-completion): `thinking: { type: "enabled" | "disabled" }`, which
 * takes precedence over `reasoning_effort`, and
 * `response_format: { type: "json_object" }`.
 */
export interface DeepSeekProviderPolicy {
  /** Stable name recorded on every attempt receipt. */
  readonly name: string;
  readonly responseFormat: "json_object";
  readonly thinking: "enabled" | "disabled";
}

/** Structured JSON output: thinking off, so the whole budget is the reply. */
export const STRUCTURED_JSON_NO_THINKING: DeepSeekProviderPolicy = Object.freeze({
  name: "structured-json/thinking-disabled@1",
  responseFormat: "json_object",
  thinking: "disabled",
});

export const DEEPSEEK_PROVIDER_POLICIES: Readonly<
  Record<BuildIntelligenceOperation, DeepSeekProviderPolicy>
> = Object.freeze({
  SEO_CONTENT_BLUEPRINT: STRUCTURED_JSON_NO_THINKING,
  STRUCTURED_CONTENT_GENERATION: STRUCTURED_JSON_NO_THINKING,
  CONTENT_VALIDATION: STRUCTURED_JSON_NO_THINKING,
});

/** The policy for an operation, or null when it has none (refused, never defaulted). */
export function providerPolicyFor(operation: string): DeepSeekProviderPolicy | null {
  return Object.hasOwn(DEEPSEEK_PROVIDER_POLICIES, operation)
    ? DEEPSEEK_PROVIDER_POLICIES[operation as BuildIntelligenceOperation]
    : null;
}

/** The DeepSeek request-body fields a policy fixes. */
export function policyRequestFields(policy: DeepSeekProviderPolicy): {
  response_format: { type: "json_object" };
  thinking: { type: "enabled" | "disabled" };
} {
  return {
    response_format: { type: policy.responseFormat },
    thinking: { type: policy.thinking },
  };
}

/**
 * The batch a purpose names: `global-intent`, `batch-N`, or null. The
 * blueprint producer's purposes are `seo-content-blueprint:global-intent:<build>`
 * and `seo-content-blueprint:batch-<n>:<build>`.
 */
export function batchFromPurpose(purpose: string): string | null {
  const batch = /(?:^|:)batch-(\d+)(?::|$)/.exec(purpose);
  if (batch) return `batch-${batch[1]}`;
  if (/(?:^|:)global-intent(?::|$)/.test(purpose)) return "global-intent";
  return null;
}

/** Where a typed provider failure happened, carried to the API response. */
export interface ProviderFailureSite {
  operation: string;
  purpose: string;
  batch: string | null;
  attempt: OperationAttempt;
}

export class ProviderRequestError extends Error {
  readonly code: string = "PROVIDER_NOT_CONFIGURED";
  site?: ProviderFailureSite;
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** The spend ledger refused the reservation; nothing was dispatched. */
export class BudgetExhaustedError extends Error {
  readonly code = "SPEND_CAP_REFUSED";
  site?: ProviderFailureSite;
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class TaskValidationError extends Error {
  readonly code = "PROVIDER_NOT_CONFIGURED";
  site?: ProviderFailureSite;
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
  override readonly code = "DEEPSEEK_TRANSPORT_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekTransportError";
  }
}
/**
 * A DeepSeek reply stopped at its output cap. Same code and contract as
 * `LlmOutputTruncatedError` (never parsed, never repaired), plus the token
 * measurements that show where the budget went.
 */
export class DeepSeekOutputTruncatedError extends LlmOutputTruncatedError {
  readonly site: ProviderFailureSite;
  readonly promptTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly policy: string;
  constructor(details: {
    site: ProviderFailureSite;
    maxOutputTokens: number;
    outputTokens: number;
    promptTokens: number | null;
    reasoningTokens: number | null;
    finishReason: string | null | undefined;
    responseLength: number;
    policy: string;
  }) {
    super({
      operation: details.site.operation,
      purpose: details.site.purpose,
      attempt: details.site.attempt,
      maxOutputTokens: details.maxOutputTokens,
      outputTokens: details.outputTokens,
      finishReason: details.finishReason,
      responseLength: details.responseLength,
    });
    this.name = "DeepSeekOutputTruncatedError";
    this.site = details.site;
    this.promptTokens = details.promptTokens;
    this.reasoningTokens = details.reasoningTokens;
    this.policy = details.policy;
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
  executePolicyJson<T>(
    operation: BuildIntelligenceOperation,
    args: BuildIntelligenceLlmArgs<T>,
  ): Promise<T>;
}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

interface Completion {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * A reply DeepSeek did not finish naturally. Only `stop` means the model ended
 * its own output. `length` is the cap, and `insufficient_system_resource`,
 * `aborted` and `content_filter` (api-docs.deepseek.com, create-chat-completion,
 * finish_reason enum) are interruptions that leave a partial reply. A missing
 * reason proves nothing about completeness. None of these is ever parsed: a cut
 * JSON body would otherwise surface as "LLM did not return valid JSON" (QAP
 * canary8) instead of the typed truncation it is.
 */
export function isIncompleteFinish(finishReason: string | null | undefined): boolean {
  return finishReason !== "stop";
}

function reportedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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

/** Price a receipt from provider-reported usage; null when usage is missing. */
function attemptCost(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  const pricing = DEEPSEEK_PEAK_PRICING[model];
  if (!pricing || promptTokens === null || completionTokens === null) return null;
  return (
    (promptTokens * pricing.inputPerMTok + completionTokens * pricing.outputPerMTok) / 1_000_000
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

  function record(args: BuildIntelligenceLlmArgs<unknown>, receipt: ProviderAttemptReceipt): void {
    args.recorder?.recordProviderAttempt(receipt);
  }

  interface Attempt {
    content: string;
    receipt: ProviderAttemptReceipt;
  }

  /**
   * One provider attempt. Every exit records exactly one receipt, except a
   * reply that came back usable: its receipt is returned unrecorded so the
   * caller can record the schema outcome once it has validated the reply.
   */
  async function complete(
    operation: string,
    policy: DeepSeekProviderPolicy,
    args: BuildIntelligenceLlmArgs<unknown>,
    userPrompt: string,
    maxOutputTokens: number,
    attempt: OperationAttempt,
  ): Promise<Attempt> {
    const site: ProviderFailureSite = {
      operation,
      purpose: args.purpose,
      batch: batchFromPurpose(args.purpose),
      attempt,
    };
    const base: ProviderAttemptReceipt = {
      attempt_id: randomUUID(),
      operation,
      purpose: args.purpose,
      batch: site.batch,
      attempt,
      provider: DEEPSEEK_PROVIDER,
      model: settings.model,
      policy: policy.name,
      max_tokens: maxOutputTokens,
      dispatched: false,
      finish_reason: null,
      prompt_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
      // Not dispatched: nothing was spent, which is known rather than assumed.
      cost_usd: 0,
      pricing_basis: DEEPSEEK_PRICING_BASIS,
      outcome: "PROVIDER_NOT_CONFIGURED",
    };
    const refuse = (error: ProviderRequestError | TaskValidationError | BudgetExhaustedError) => {
      error.site = site;
      record(args, {
        ...base,
        outcome: error instanceof BudgetExhaustedError ? "SPEND_CAP_REFUSED" : base.outcome,
      });
      return error;
    };
    if (!settings.apiKey) {
      throw refuse(
        new ProviderRequestError("Missing required LLM configuration: DEEPSEEK_API_KEY"),
      );
    }
    const pricing = DEEPSEEK_PEAK_PRICING[settings.model];
    if (!pricing) {
      throw refuse(
        new TaskValidationError(
          `DEEPSEEK_MODEL ${settings.model} has no verified pricing; not dispatched`,
        ),
      );
    }
    const inputBound =
      Buffer.byteLength(args.systemPrompt, "utf8") + Buffer.byteLength(userPrompt, "utf8");
    const reservation =
      (inputBound * pricing.inputPerMTok + maxOutputTokens * pricing.outputPerMTok) / 1_000_000;
    try {
      reserveSpend(ledgerDir, args, settings.ceilings, reservation, now());
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw refuse(error);
      throw error;
    }
    // From here the request is dispatched. A transport failure leaves the
    // provider's charge unknown, so its cost is null, not 0.
    const dispatched: ProviderAttemptReceipt = { ...base, dispatched: true, cost_usd: null };
    const transportFailure = (message: string) => {
      record(args, { ...dispatched, outcome: "TRANSPORT_ERROR" });
      const error = new DeepSeekTransportError(message);
      error.site = site;
      return error;
    };
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
          ...policyRequestFields(policy),
          stream: false,
        }),
        signal: AbortSignal.timeout(LLM_PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      throw transportFailure(
        `DeepSeek request failed for ${operation} (${error instanceof Error ? error.name : "error"})`,
      );
    }
    if (!response.ok) {
      throw transportFailure(`DeepSeek HTTP ${response.status} for ${operation}`);
    }
    let completion: Completion;
    try {
      completion = (await response.json()) as Completion;
    } catch {
      throw transportFailure(`DeepSeek returned a non-JSON body for ${operation}`);
    }
    const choice = completion.choices?.[0];
    const content = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason ?? "missing";
    const promptTokens = reportedCount(completion.usage?.prompt_tokens);
    const completionTokens = reportedCount(completion.usage?.completion_tokens);
    const reasoningTokens = reportedCount(
      completion.usage?.completion_tokens_details?.reasoning_tokens,
    );
    const outputTokens = completionTokens ?? 0;
    const measured: ProviderAttemptReceipt = {
      ...dispatched,
      finish_reason: choice?.finish_reason ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      cost_usd: attemptCost(settings.model, promptTokens, completionTokens),
      outcome: "OK",
    };
    if (args.callCounter) args.callCounter.value += 1;
    args.recorder?.attributeOperationCall({
      operation,
      purpose: args.purpose,
      attempt,
      descriptorRequiresSearch: false,
      decisions: [
        {
          taskId: measured.attempt_id,
          provider: DEEPSEEK_PROVIDER,
          model: settings.model,
          searchRequired: false,
          searchPolicySource: "EXPLICIT",
          outcome: "SUCCESS",
        } as never,
      ],
      response: { provider: DEEPSEEK_PROVIDER },
    });
    if (
      isTruncatedFinish(finishReason, outputTokens, maxOutputTokens) ||
      isIncompleteFinish(choice?.finish_reason)
    ) {
      record(args, { ...measured, outcome: "OUTPUT_TRUNCATED" });
      throw new DeepSeekOutputTruncatedError({
        site,
        maxOutputTokens,
        outputTokens,
        promptTokens,
        reasoningTokens,
        finishReason,
        responseLength: content.length,
        policy: policy.name,
      });
    }
    return { content, receipt: measured };
  }

  /** Validate one reply and record its attempt with the schema outcome. */
  function settle<T>(
    args: BuildIntelligenceLlmArgs<T>,
    result: Attempt,
  ): { ok: true; value: T } | { ok: false; error: unknown } {
    let outcome: ProviderAttemptOutcome = "OK";
    try {
      const value = args.validate(parseJsonFromLlm(result.content));
      return { ok: true, value };
    } catch (error) {
      outcome = "SCHEMA_INVALID";
      return { ok: false, error };
    } finally {
      record(args as BuildIntelligenceLlmArgs<unknown>, { ...result.receipt, outcome });
    }
  }

  const client: BuildIntelligenceLlm = {
    async strategizeJson(args) {
      return client.executePolicyJson("SEO_CONTENT_BLUEPRINT", args);
    },
    async executePolicyJson(operation, args) {
      const policy = providerPolicyFor(operation);
      if (!policy) {
        const error = new TaskValidationError(
          `operation ${String(operation)} has no DeepSeek provider policy; not dispatched`,
        );
        error.site = {
          operation: String(operation),
          purpose: args.purpose,
          batch: batchFromPurpose(args.purpose),
          attempt: "initial",
        };
        throw error;
      }
      const repairAttempts = args.schemaRepairAttempts ?? 1;
      const requested = args.expectedOutputTokens ?? DEFAULT_OUTPUT_TOKENS[operation] ?? 2_500;
      const maxOutputTokens = Math.min(OUTPUT_CEILING, Math.max(1, requested));
      const unknownArgs = args as BuildIntelligenceLlmArgs<unknown>;
      const first = settle(
        args,
        await complete(operation, policy, unknownArgs, args.userPrompt, maxOutputTokens, "initial"),
      );
      if (first.ok) return first.value;
      // The validator's own error is rethrown unchanged: callers tell a failed
      // validation from a failed call by its identity.
      if (repairAttempts === 0) throw first.error;
      const reason = first.error instanceof Error ? first.error.message : String(first.error);
      const repairPrompt = `${args.userPrompt}\n\n---\nYour previous response was rejected: ${reason}\nRespond again with ONLY a single valid JSON value. No prose, no markdown fences.`;
      const second = settle(
        args,
        await complete(operation, policy, unknownArgs, repairPrompt, maxOutputTokens, "repair"),
      );
      if (second.ok) return second.value;
      throw second.error;
    },
  };
  return client;
}

let singleton: BuildIntelligenceLlm | undefined;

export function getDeepSeekBuildIntelligenceLlm(): BuildIntelligenceLlm {
  singleton ??= createDeepSeekBuildIntelligenceLlm();
  return singleton;
}
