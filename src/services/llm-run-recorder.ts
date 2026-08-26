/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Run-scoped LLM execution recorder — the measurement layer for
 * `l9.seo-bot-run-llm-audit/v1`.
 *
 * This module MEASURES; it decides nothing. It never chooses a provider, a
 * model, a task type, a search policy, a repair budget, or a prompt — it only
 * records what the router actually did, at the one layer that knows: the
 * boundary in `services/llm.ts` where `L9LLMRouter.execute()` is invoked.
 *
 * Three classes of evidence are captured:
 *
 *   1. GOVERNED OPERATION EXECUTIONS — one entry per ACTUAL router call made by
 *      `LlmService.executePolicyJson`. Search policy is not re-derived here: the
 *      applied `searchRequired` / `searchPolicySource` are read back off the
 *      router's own `RoutingDecision` (its call log), and the descriptor's
 *      `requiresSearch` is recorded alongside so `EXPLICIT` can be proven rather
 *      than asserted.
 *
 *   2. UNSUPPORTED CAPABILITY COMBINATIONS — the router raises
 *      `UnsupportedCapabilityCombinationError` from route resolution, BEFORE it
 *      appends anything to its call log. Such a call is therefore invisible in
 *      the log and must be counted where it surfaces: the catch in
 *      `LlmService.execute`.
 *
 *   3. DIRECT PROVIDER BYPASSES — a provider reached outside
 *      `@quantum-l9/llm-router`. SEO-Bot has exactly one sanctioned such site
 *      (the AEO answer-engine observation port, where the engine IS the
 *      measurement subject); it reports every invocation here.
 *
 * Counters are LENGTHS OF OBSERVED EVENT LISTS, never constants. A zero in the
 * exported audit means "no such event was observed during this run", and the
 * schema validator re-derives every count from its event list, so a fabricated
 * zero cannot survive validation.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { RoutingDecision } from "@quantum-l9/llm-router";
import type { SeoImproveLlmOperation } from "./improve-llm-policy.js";

/**
 * Governed operations whose execution policy the audit must prove.
 *
 * `satisfies` binds this list to the policy union so it cannot drift: renaming
 * an operation in `improve-llm-policy.ts` is a compile error here rather than
 * an audit that silently stops matching the operation it is named after.
 */
export const AUDITED_OPERATIONS = [
  "SEO_CONTENT_BLUEPRINT",
  "STRUCTURED_CONTENT_GENERATION",
  "CONTENT_VALIDATION",
] as const satisfies readonly SeoImproveLlmOperation[];

export type AuditedOperation = (typeof AUDITED_OPERATIONS)[number];

export function isAuditedOperation(value: string): value is AuditedOperation {
  return (AUDITED_OPERATIONS as readonly string[]).includes(value);
}

/** Which of the two LLM calls a bounded-repair operation may make this was. */
export type OperationAttempt = "initial" | "repair";

/**
 * One ACTUAL governed router call. Every field except `operation`, `purpose`,
 * and `attempt` is read back from the router's own recorded decision — SEO-Bot
 * never restates what it *intended* the routing to be.
 */
export interface OperationExecutionEvidence {
  operation: AuditedOperation;
  /** `[module] purpose` string the operation was dispatched with. */
  purpose: string;
  attempt: OperationAttempt;
  /** Router-assigned id of the routed call. */
  task_id: string;
  provider: string;
  model: string;
  /**
   * APPLIED search requirement, as resolved by the router.
   *
   * `searchRequired` / `searchPolicySource` keep the router's own camelCase
   * spelling because they are verbatim `RoutingDecision` evidence, not
   * SEO-Bot vocabulary — which is also the spelling the governed-run oracle
   * requires of them downstream.
   */
  searchRequired: boolean;
  /**
   * APPLIED policy source, canonicalized from the router's enum.
   *
   * Deliberately `string` and not the canonical union: this layer MEASURES,
   * and it cannot promise the router returned a value it recognises. An
   * unrecognised value is carried verbatim so the audit schema — the layer
   * that validates — rejects it. Narrowing here would take a cast, and the
   * cast would be a lie.
   */
  searchPolicySource: string;
  /**
   * The `requiresSearch` value the governed operation actually supplied on the
   * TaskDescriptor handed to the router, or `null` when it supplied none.
   * `searchPolicySource: "EXPLICIT"` is only truthful when this is a boolean.
   */
  descriptor_requires_search: boolean | null;
  outcome: "SUCCESS" | "FAILED";
}

/**
 * Canonical spelling of the router's `SearchPolicySource` enum.
 *
 * The router reports lowercase enum VALUES (`explicit`, `task_default`); the
 * audit records the enum NAME. Mapping by name rather than upper-casing an
 * arbitrary string keeps the translation total: an unrecognised value passes
 * through verbatim and is rejected by the audit schema instead of being
 * upper-cased into something that merely looks canonical.
 */
export type SearchPolicySourceName = "EXPLICIT" | "TASK_DEFAULT";

const SEARCH_POLICY_SOURCE_NAMES: Readonly<Record<string, SearchPolicySourceName>> = {
  explicit: "EXPLICIT",
  task_default: "TASK_DEFAULT",
  EXPLICIT: "EXPLICIT",
  TASK_DEFAULT: "TASK_DEFAULT",
};

/**
 * Returns the canonical NAME for a recognised source value, or the value
 * verbatim for anything else.
 *
 * The return type is `string` rather than `SearchPolicySourceName | string` —
 * which would collapse to `string` anyway — because the honest answer is that
 * this function cannot guarantee canonicality. The audit schema's enum is what
 * narrows, and it rejects whatever this could not map.
 */
export function canonicalSearchPolicySource(value: unknown): string {
  const key = String(value);
  return SEARCH_POLICY_SOURCE_NAMES[key] ?? key;
}

/** A capability combination the router refused before any provider dispatch. */
export interface CapabilityRejectionEvidence {
  /** Router capability-conflict code, e.g. UNSUPPORTED_CAPABILITY_COMBINATION. */
  code: string;
  /** Task type of the refused descriptor. */
  task_type: string;
  /** Governed operation when the refusal happened inside one, else null. */
  operation: string | null;
  message: string;
}

/** A provider reached outside @quantum-l9/llm-router. */
export interface DirectProviderBypassEvidence {
  /** Bypass site identifier, e.g. "aeo-geo:answer-engine-observation". */
  site: string;
  /** Engine/provider observed at that site. */
  engine: string;
  /** Why the bypass is sanctioned (or why it happened). */
  rationale: string;
}

/**
 * An evidence attribution that could not be made exactly. Never silently
 * dropped: the schema validator refuses an audit that carries any of these, so
 * an unattributable call fails the evidence rather than under-reporting it.
 */
export interface AttributionFailureEvidence {
  operation: string;
  purpose: string;
  attempt: OperationAttempt;
  reason: string;
}

export interface RunRecorderLeg {
  competitive_landscape: boolean;
  seo_content_blueprint: boolean;
  structured_content: boolean;
}

/**
 * Collects one run's LLM execution evidence. A recorder is OPEN from
 * construction until `close()`; while open it also receives out-of-stack events
 * (capability rejections and direct provider bypasses) published through this
 * module's registry.
 */
export class LlmRunRecorder {
  private readonly seenTaskIds = new Set<string>();
  private readonly operations: OperationExecutionEvidence[] = [];
  private readonly capabilityRejections: CapabilityRejectionEvidence[] = [];
  private readonly directProviderBypasses: DirectProviderBypassEvidence[] = [];
  private readonly attributionFailures: AttributionFailureEvidence[] = [];
  private open = true;

  constructor(readonly runId: string) {
    OPEN_RECORDERS.add(this);
  }

  /** Stop receiving out-of-stack events. Idempotent. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    OPEN_RECORDERS.delete(this);
  }

  /**
   * Attribute one ACTUAL governed router call from the router's call log.
   *
   * `decisions` is the router's own log slice for this client. Exactly one
   * entry must be new since the previous attribution — the build-intelligence
   * pipeline dispatches its governed calls sequentially, so anything else means
   * the evidence cannot be attributed and is recorded as a failure instead of
   * being guessed.
   */
  attributeOperationCall(input: {
    operation: string;
    purpose: string;
    attempt: OperationAttempt;
    descriptorRequiresSearch: boolean | null;
    decisions: readonly RoutingDecision[];
    /** Provider plane the call actually answered on, when it succeeded. */
    response?: { provider: string };
  }): void {
    const fresh = input.decisions.filter((decision) => !this.seenTaskIds.has(decision.taskId));
    for (const decision of fresh) this.seenTaskIds.add(decision.taskId);

    if (!isAuditedOperation(input.operation)) {
      // Not an audited operation: the decisions are still marked seen so a
      // later audited call cannot mis-claim them.
      return;
    }
    if (fresh.length !== 1) {
      this.attributionFailures.push({
        operation: input.operation,
        purpose: input.purpose,
        attempt: input.attempt,
        reason: `expected exactly 1 new router decision for this call, observed ${fresh.length}`,
      });
      return;
    }
    const decision = fresh[0] as RoutingDecision;
    // Cross-check the PLANE, not the model: a within-provider fallback may
    // legitimately answer on a different model than the one first routed, but
    // the provider plane can never differ from the audited decision — the
    // router itself refuses to dispatch a decision onto the other plane.
    if (input.response && String(decision.provider) !== input.response.provider) {
      this.attributionFailures.push({
        operation: input.operation,
        purpose: input.purpose,
        attempt: input.attempt,
        reason:
          `router decision resolved provider ${String(decision.provider)} but the call was ` +
          `answered by ${input.response.provider}`,
      });
      return;
    }
    this.operations.push({
      operation: input.operation,
      purpose: input.purpose,
      attempt: input.attempt,
      task_id: decision.taskId,
      provider: String(decision.provider),
      model: String(decision.model),
      searchRequired: decision.searchRequired,
      searchPolicySource: canonicalSearchPolicySource(decision.searchPolicySource),
      descriptor_requires_search: input.descriptorRequiresSearch,
      outcome: decision.outcome === "FAILED" ? "FAILED" : "SUCCESS",
    });
  }

  recordCapabilityRejection(evidence: CapabilityRejectionEvidence): void {
    this.capabilityRejections.push(evidence);
  }

  recordDirectProviderBypass(evidence: DirectProviderBypassEvidence): void {
    this.directProviderBypasses.push(evidence);
  }

  operationsFor(operation: AuditedOperation): OperationExecutionEvidence[] {
    return this.operations.filter((entry) => entry.operation === operation);
  }

  snapshot(): {
    operations: OperationExecutionEvidence[];
    capability_rejections: CapabilityRejectionEvidence[];
    direct_provider_bypasses: DirectProviderBypassEvidence[];
    attribution_failures: AttributionFailureEvidence[];
  } {
    return {
      operations: this.operations.map((entry) => ({ ...entry })),
      capability_rejections: this.capabilityRejections.map((entry) => ({ ...entry })),
      direct_provider_bypasses: this.directProviderBypasses.map((entry) => ({ ...entry })),
      attribution_failures: this.attributionFailures.map((entry) => ({ ...entry })),
    };
  }
}

/* ── Out-of-stack event registry ─────────────────────────────────────────────
 * A capability rejection and a direct provider bypass can both occur outside
 * the producer's call stack, so they cannot be returned up through it. Open
 * recorders subscribe here; publishers fan out to all of them. Publishing is a
 * pure observation — it never alters control flow, and with no open recorder it
 * is a no-op.
 * ──────────────────────────────────────────────────────────────────────────── */

const OPEN_RECORDERS = new Set<LlmRunRecorder>();

export function publishCapabilityRejection(evidence: CapabilityRejectionEvidence): void {
  for (const recorder of OPEN_RECORDERS) recorder.recordCapabilityRejection(evidence);
}

export function publishDirectProviderBypass(evidence: DirectProviderBypassEvidence): void {
  for (const recorder of OPEN_RECORDERS) recorder.recordDirectProviderBypass(evidence);
}

/** Test-only: number of recorders currently subscribed to run events. */
export function _openRecorderCount(): number {
  return OPEN_RECORDERS.size;
}
