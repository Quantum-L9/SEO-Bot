/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 * version: 3.0.0
 */
import {
  type BudgetConfig,
  BudgetExhaustedError,
  L9LLMRouter,
  type LLMResponse,
  type RoutingDecision,
  TaskComplexity,
  type TaskDescriptor,
  TaskType,
} from "@quantum-l9/llm-router";
import type { FullSiteQAConfig, VisualQATask } from "@quantum-l9/llm-router/vision";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";
import { createModuleLogger } from "../core/logger.js";
import type { ModuleName } from "../types/index.js";
import { type SeoImproveLlmOperation, seoImproveTask } from "./improve-llm-policy.js";
import { parseJsonFromLlm, parseScore } from "./llm-parse.js";
import {
  type LlmRunRecorder,
  type OperationAttempt,
  publishCapabilityRejection,
} from "./llm-run-recorder.js";
import { hydrateSeoContext } from "./memory.js";

const logger = createModuleLogger("llm");

export class DailyBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBudgetExhaustedError";
  }
}

type LegacyTier = "fast" | "strategic";
function tierToComplexity(tier: LegacyTier): TaskComplexity {
  return tier === "fast" ? TaskComplexity.LOW : TaskComplexity.HIGH;
}

/**
 * Shared counter for run evidence: one increment per ACTUAL router call.
 * Passed by reference so callers that compose policy-JSON operations (e.g.
 * the structured-content orchestrator) can report honest call counts even
 * when a callee internally performs its one bounded repair.
 */
export interface LlmCallCounter {
  value: number;
}

/**
 * How far back the router call log is read when attributing ONE governed call.
 * Only decisions this recorder has not already claimed are considered, so the
 * window merely has to be larger than the number of calls a single operation
 * can make (two, with its bounded repair).
 */
const ROUTER_ATTRIBUTION_WINDOW = 50;

/**
 * A capability combination the router refuses is raised from route resolution,
 * BEFORE the decision is appended to the call log — so it is invisible to log
 * attribution and must be recognised where it surfaces.
 */
function capabilityConflictCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "UnsupportedCapabilityCombinationError") {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : "UNSUPPORTED_CAPABILITY_COMBINATION";
}

export class LlmService {
  private readonly router: L9LLMRouter;

  constructor() {
    const config = getConfig();
    const budget: BudgetConfig = {
      monthlyBudgetPerClient: config.DEFAULT_CLIENT_MONTHLY_BUDGET,
      weeklyTarget: config.DEFAULT_CLIENT_WEEKLY_TARGET,
      weeklyHardCeiling: config.DEFAULT_CLIENT_WEEKLY_CEILING,
      globalMonthlyHardCeiling: config.GLOBAL_MONTHLY_HARD_CEILING,
      surgeThreshold: config.SURGE_THRESHOLD,
    };
    this.router = new L9LLMRouter({
      perplexityApiKey: config.PERPLEXITY_API_KEY,
      openrouterApiKey: config.OPENROUTER_API_KEY,
      appName: "L9-SEO-Bot",
      budget,
    });
    logger.info("LLM Service initialized; cognitive memory is delegated to l9-graphiti-memory");
  }

  getRouter(): L9LLMRouter {
    return this.router;
  }
  recoverExpiredBudgetReservations(): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * The ONE layer that knows a provider/model execution actually happened: every
   * SEO-Bot LLM call funnels through here into `L9LLMRouter.execute`.
   *
   * `audit` carries only the governed-operation label so a refused capability
   * combination can be attributed to the operation that asked for it. It never
   * influences routing.
   */
  async execute(
    task: TaskDescriptor,
    systemPrompt: string,
    userPrompt: string,
    options?: { images?: string[]; assistantContext?: string; consensus?: boolean },
    audit?: { operation: string },
  ): Promise<LLMResponse> {
    if (!task.clientId) throw new Error("LLM task clientId is required");
    // Idempotent: registered clients keep their persisted budget state; build-time
    // clients (pre-registration intelligence calls) get the default budget account.
    await this.initClient(task.clientId);
    await this.enforceDailyCap(task);
    try {
      const memoryContext = await hydrateSeoContext(
        task.clientId,
        task.type,
        task.description ?? "SEO task",
        [this.extractModule(task.description), task.type],
      );
      const response = await this.router.execute(
        task,
        `${systemPrompt}${memoryContext}`,
        userPrompt,
        options,
      );
      await this.logUsage(task, response);
      return response;
    } catch (error: any) {
      if (error instanceof BudgetExhaustedError) {
        logger.warn(
          {
            clientId: task.clientId,
            taskType: task.type,
            complexity: task.complexity,
            reason: error.message,
          },
          "Task deferred by budget engine",
        );
      } else {
        logger.error({ error: error.message, task: task.description }, "LLM execution failed");
      }
      // A refused capability combination never reaches the router's call log
      // (it is raised during route resolution), so this catch is the only place
      // it can be counted. Observation only — the error still propagates.
      const conflictCode = capabilityConflictCode(error);
      if (conflictCode) {
        publishCapabilityRejection({
          code: conflictCode,
          task_type: String(task.type),
          operation: audit?.operation ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async classify(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.CLASSIFICATION,
        complexity: TaskComplexity.LOW,
        expectedOutputTokens: 100,
        description: `[${module}] ${purpose}`,
      },
      "You are a precise classifier. Respond with only the classification label, no explanation.",
      prompt,
    );
    return response.content.trim();
  }

  async extractJson<T>(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.LOW,
  ): Promise<T> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.EXTRACTION,
        complexity,
        expectedOutputTokens: 1000,
        description: `[${module}] ${purpose}`,
      },
      "You are a precise data extractor. Always respond with valid JSON only. No markdown fences.",
      prompt,
    );
    return parseJsonFromLlm<T>(response.content);
  }

  async score(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
  ): Promise<number> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.SCORING,
        complexity: TaskComplexity.LOW,
        expectedOutputTokens: 50,
        description: `[${module}] ${purpose}`,
      },
      "You are a precise scorer. Respond with only a number between 0 and 100, no explanation.",
      prompt,
    );
    return parseScore(response.content);
  }

  async generateContent(
    systemPrompt: string,
    userPrompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.CONTENT_GENERATION,
        complexity,
        expectedOutputTokens: 3000,
        description: `[${module}] ${purpose}`,
      },
      systemPrompt,
      userPrompt,
    );
    return response.content;
  }

  async strategize(
    systemPrompt: string,
    userPrompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.HIGH,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.STRATEGIC_REASONING,
        complexity,
        expectedOutputTokens: 4000,
        requiresReasoning: true,
        description: `[${module}] ${purpose}`,
      },
      systemPrompt,
      userPrompt,
    );
    return response.content;
  }

  /**
   * Execute a governed SEO-improve LLM operation whose output must be valid,
   * schema-conformant JSON. Task cognition (STRATEGIC_REASONING /
   * CONTENT_GENERATION / SCORING) and the hard search flag come entirely from
   * {@link SEO_IMPROVE_LLM_POLICY} — the caller never chooses a task type,
   * provider, or model. Parse+validate failures trigger AT MOST ONE bounded
   * repair scoped to the same operation; a second failure is terminal (the
   * validator's error propagates). No infinite retry.
   *
   * `schemaRepairAttempts: 0` opts OUT of the internal repair: the caller owns
   * the one total repair for the route (StructuredContentPackage does this so
   * a route can never consume more than two generation calls). The default of
   * 1 keeps every pre-existing caller's behavior unchanged.
   */
  async executePolicyJson<T>(
    operation: SeoImproveLlmOperation,
    args: {
      clientId: string;
      module: ModuleName;
      purpose: string;
      systemPrompt: string;
      userPrompt: string;
      validate: (value: unknown) => T;
      /** 0 = no internal JSON/schema repair; 1 = one bounded repair (default). */
      schemaRepairAttempts?: 0 | 1;
      /** Incremented once per actual LLM call, when supplied. */
      callCounter?: LlmCallCounter;
      /** Records the router's own decision for each actual call, when supplied. */
      recorder?: LlmRunRecorder;
    },
  ): Promise<T> {
    const repairAttempts = args.schemaRepairAttempts ?? 1;
    if (repairAttempts !== 0 && repairAttempts !== 1) {
      throw new Error("schemaRepairAttempts must be 0 or 1");
    }
    const task = seoImproveTask(operation, args.clientId, `[${args.module}] ${args.purpose}`);
    const purpose = `[${args.module}] ${args.purpose}`;
    const first = await this.executeGoverned(operation, task, args, purpose, "initial");
    if (args.callCounter) args.callCounter.value += 1;
    try {
      return args.validate(parseJsonFromLlm<unknown>(first.content));
    } catch (error) {
      if (repairAttempts === 0) {
        // The caller owns the one total repair; propagate the parse/schema
        // failure with no hidden nested retry.
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        { operation, clientId: args.clientId, purpose: args.purpose, reason },
        "Policy JSON invalid; attempting one bounded repair",
      );
      const repairPrompt =
        `${args.userPrompt}\n\n---\nYour previous response was rejected: ${reason}\n` +
        `Respond again with ONLY a single valid JSON value that satisfies the required schema. No prose, no markdown fences.`;
      const second = await this.executeGoverned(
        operation,
        task,
        { ...args, userPrompt: repairPrompt },
        purpose,
        "repair",
      );
      if (args.callCounter) args.callCounter.value += 1;
      // A second failure throws the validator's terminal error — no further retry.
      return args.validate(parseJsonFromLlm<unknown>(second.content));
    }
  }

  /**
   * Dispatch ONE actual governed call and record the router's own decision for
   * it.
   *
   * Nothing about the routing is restated from SEO-Bot's intent: the applied
   * `searchRequired` / `searchPolicySource` are read back off the router call
   * log, and the descriptor's `requiresSearch` is recorded beside them so
   * `EXPLICIT` can be checked against what the governed operation actually
   * supplied rather than trusted.
   */
  private async executeGoverned(
    operation: SeoImproveLlmOperation,
    task: TaskDescriptor,
    args: { systemPrompt: string; userPrompt: string; recorder?: LlmRunRecorder },
    purpose: string,
    attempt: OperationAttempt,
  ): Promise<LLMResponse> {
    const response = await this.execute(task, args.systemPrompt, args.userPrompt, undefined, {
      operation,
    });
    args.recorder?.attributeOperationCall({
      operation,
      purpose,
      attempt,
      descriptorRequiresSearch:
        typeof task.requiresSearch === "boolean" ? task.requiresSearch : null,
      decisions: this.router.getCallLogByClient(
        task.clientId ?? "default",
        ROUTER_ATTRIBUTION_WINDOW,
      ),
      response: { provider: String(response.provider) },
    });
    return response;
  }

  /**
   * Strategic-reasoning JSON op (SEO_CONTENT_BLUEPRINT). Reasoning, not search:
   * consumes normalized evidence and returns a validated strategic artifact.
   * Task semantics describe cognition, not serialization — this is deliberately
   * NOT the EXTRACTION path even though the output is JSON.
   */
  async strategizeJson<T>(args: {
    clientId: string;
    module: ModuleName;
    purpose: string;
    systemPrompt: string;
    userPrompt: string;
    validate: (value: unknown) => T;
    /** Records the router's own decision for each actual call, when supplied. */
    recorder?: LlmRunRecorder;
  }): Promise<T> {
    return this.executePolicyJson("SEO_CONTENT_BLUEPRINT", args);
  }

  async research(
    prompt: string,
    clientId: string,
    module: ModuleName,
    purpose: string,
    taskType: TaskType = TaskType.COMPETITOR_RESEARCH,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
    options?: { domainFilter?: string[]; consensus?: boolean },
  ): Promise<LLMResponse> {
    return this.execute(
      {
        clientId,
        type: taskType,
        complexity,
        requiresSearch: true,
        domainFilter: options?.domainFilter,
        description: `[${module}] ${purpose}`,
      },
      "You are an expert SEO researcher. Provide factual, citation-backed answers.",
      prompt,
      { consensus: options?.consensus },
    );
  }

  async checkCitation(query: string, clientId: string, targetDomain: string): Promise<LLMResponse> {
    return this.execute(
      {
        clientId,
        type: TaskType.CITATION_CHECK,
        complexity: TaskComplexity.MEDIUM,
        requiresSearch: true,
        description: `[aeo-geo] Citation check: "${query}" -> ${targetDomain}`,
      },
      "Answer the following question naturally and thoroughly. Cite your sources.",
      query,
    );
  }

  async analyzeScreenshot(
    prompt: string,
    imageUrls: string[],
    clientId: string,
    module: ModuleName,
    purpose: string,
    complexity: TaskComplexity = TaskComplexity.MEDIUM,
  ): Promise<string> {
    const response = await this.execute(
      {
        clientId,
        type: TaskType.LAYOUT_VALIDATION,
        complexity,
        images: imageUrls,
        description: `[${module}] ${purpose}`,
      },
      "You are a professional web designer and UX expert. Analyze the screenshot for layout issues, misalignment, broken elements, and visual quality.",
      prompt,
      { images: imageUrls },
    );
    return response.content;
  }

  planVisualQA(config: FullSiteQAConfig): VisualQATask[] {
    return this.router.planVisualQA(config);
  }

  async call(request: {
    tier: LegacyTier;
    systemPrompt: string;
    userPrompt: string;
    clientId: string;
    module: ModuleName;
    purpose: string;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: "text" | "json";
  }): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    model: string;
  }> {
    const response = await this.execute(
      {
        clientId: request.clientId,
        type: request.responseFormat === "json" ? TaskType.EXTRACTION : TaskType.CONTENT_GENERATION,
        complexity: tierToComplexity(request.tier),
        expectedOutputTokens: request.maxTokens,
        description: `[${request.module}] ${request.purpose}`,
      },
      request.systemPrompt,
      request.userPrompt,
    );
    return {
      content: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cost: response.cost,
      model: response.model,
    };
  }

  async initClient(clientId: string, budgetOverrides?: Partial<BudgetConfig>): Promise<void> {
    await this.router.initClient(clientId, budgetOverrides);
    logger.info(
      { clientId, overrides: budgetOverrides },
      "Client initialized in persistent LLM budget ledger",
    );
  }

  getClientBudgetReport(clientId: string) {
    return this.router.getClientBudgetReportAsync(clientId);
  }
  getAllBudgetReports() {
    return this.router.getAllBudgetReportsAsync();
  }
  getGlobalSpend() {
    return this.router.getGlobalSpendAsync();
  }

  private async enforceDailyCap(task: TaskDescriptor): Promise<void> {
    const cap = getConfig().DAILY_SPEND_CAP;
    if (!cap || cap <= 0) return;
    const spent = await this.getDailySpend();
    if (spent >= cap) {
      logger.warn(
        { clientId: task.clientId, spent, cap },
        "Daily LLM spend cap reached; deferring task",
      );
      throw new DailyBudgetExhaustedError(
        `Daily LLM spend cap reached ($${spent.toFixed(2)} >= $${cap.toFixed(2)})`,
      );
    }
  }

  async getDailySpend(): Promise<number> {
    try {
      const { gte, sql } = await import("drizzle-orm");
      const db = getDb();
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const result = await db
        .select({ totalCost: sql<number>`COALESCE(SUM(${schema.llmUsage.cost}), 0)` })
        .from(schema.llmUsage)
        .where(gte(schema.llmUsage.timestamp, todayStart));
      return Number(result[0]?.totalCost ?? 0);
    } catch (error: any) {
      logger.warn(
        { error: error.message },
        "getDailySpend DB query failed, falling back to in-memory call log",
      );
      const today = new Date().toISOString().slice(0, 10);
      return this.router
        .getCallLog(Number.MAX_SAFE_INTEGER)
        .filter((entry) => {
          const date = new Date(entry.timestamp);
          return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === today;
        })
        .reduce((sum, entry) => sum + (entry.actualCost ?? 0), 0);
    }
  }

  getCallLog(limit = 100): RoutingDecision[] {
    return this.router.getCallLog(limit);
  }
  getCallLogByClient(clientId: string, limit = 50): RoutingDecision[] {
    return this.router.getCallLogByClient(clientId, limit);
  }

  private async logUsage(task: TaskDescriptor, response: LLMResponse): Promise<void> {
    const clientId = task.clientId?.trim();
    if (!clientId) {
      logger.warn({ purpose: task.description }, "Skipping LLM usage log: task.clientId missing");
      return;
    }
    try {
      await getDb()
        .insert(schema.llmUsage)
        .values({
          clientId,
          module: this.extractModule(task.description),
          tier: this.inferTier(task.complexity),
          purpose: task.description ?? "unspecified",
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cost: response.cost,
        });
    } catch (error: any) {
      logger.warn({ error: error.message }, "Failed to log LLM usage to database");
    }
  }

  private extractModule(description?: string): string {
    if (!description) return "unknown";
    return description.match(/\[([^\]]+)\]/)?.[1] ?? "unknown";
  }

  private inferTier(complexity: TaskComplexity): string {
    if (complexity === TaskComplexity.TRIVIAL || complexity === TaskComplexity.LOW) return "fast";
    if (complexity === TaskComplexity.MEDIUM) return "standard";
    return "strategic";
  }
}

let _llmService: LlmService | null = null;
export function getLlmService(): LlmService {
  if (!_llmService) _llmService = new LlmService();
  return _llmService;
}

export type { LLMResponse, RoutingDecision, TaskDescriptor } from "@quantum-l9/llm-router";
export { BudgetExhaustedError, TaskComplexity, TaskType } from "@quantum-l9/llm-router";
export type { FullSiteQAConfig, VisualQATask } from "@quantum-l9/llm-router/vision";
