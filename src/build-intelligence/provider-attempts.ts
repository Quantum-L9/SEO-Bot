/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * l9.seo-bot-provider-attempts/v1 — every provider attempt of one run.
 *
 * `l9.seo-bot-run-llm-audit/v1` describes runs whose legs SUCCEEDED and fails
 * closed on anything else. This document is its companion for spend and
 * failure. It holds one receipt per provider attempt, success or failure,
 * including attempts refused before dispatch and attempts of legs that failed.
 * It is keyed by the same run id.
 *
 * Spend is never asserted. `spend_usd` is the sum of the receipts' `cost_usd`,
 * and the validator recomputes it. An attempt whose cost is unknown (usage not
 * reported, or a transport failure after dispatch) is counted in
 * `unpriced_attempt_count`, never summed as zero.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { z } from "zod";

export const PROVIDER_ATTEMPTS_SCHEMA = "l9.seo-bot-provider-attempts/v1" as const;

/** Float tolerance for the spend-sum invariant (sums are recomputed in order). */
const SPEND_EPSILON = 1e-9;

export class ProviderAttemptsInvalidError extends Error {
  readonly code = "PROVIDER_ATTEMPTS_INVALID";
  constructor(
    message: string,
    readonly violations: string[] = [],
  ) {
    super(message);
    this.name = "ProviderAttemptsInvalidError";
  }
}

const tokenCount = z.number().int().min(0).nullable();

export const providerAttemptReceiptSchema = z
  .object({
    attempt_id: z.string().min(1),
    operation: z.string().min(1),
    purpose: z.string().min(1),
    batch: z.string().min(1).nullable(),
    attempt: z.enum(["initial", "repair"]),
    provider: z.string().min(1),
    model: z.string().min(1),
    policy: z.string().min(1),
    max_tokens: z.number().int().min(1),
    dispatched: z.boolean(),
    finish_reason: z.string().nullable(),
    prompt_tokens: tokenCount,
    completion_tokens: tokenCount,
    reasoning_tokens: tokenCount,
    cost_usd: z.number().min(0).nullable(),
    pricing_basis: z.string().min(1),
    outcome: z.enum([
      "OK",
      "SCHEMA_INVALID",
      "OUTPUT_TRUNCATED",
      "TRANSPORT_ERROR",
      "SPEND_CAP_REFUSED",
      "PROVIDER_NOT_CONFIGURED",
    ]),
  })
  .strict();

const legFailureSchema = z
  .object({
    leg: z.enum(["competitive_landscape", "seo_content_blueprint", "structured_content"]),
    code: z.string().min(1),
    operation: z.string().min(1).nullable(),
    batch: z.string().min(1).nullable(),
  })
  .strict();

const providerAttemptsSchema = z
  .object({
    schema: z.literal(PROVIDER_ATTEMPTS_SCHEMA),
    run_id: z.string().min(1),
    client_id: z.string().min(1),
    build_id: z.string().min(1),
    produced_at: z.string().min(1),
    attempt_count: z.number().int().min(0),
    attempts: z.array(providerAttemptReceiptSchema),
    spend_usd: z.number().min(0),
    unpriced_attempt_count: z.number().int().min(0),
    leg_failures: z.array(legFailureSchema),
  })
  .strict();

export type ProviderAttemptsV1 = z.infer<typeof providerAttemptsSchema>;
export type ProviderLegFailure = z.infer<typeof legFailureSchema>;
type Receipt = z.infer<typeof providerAttemptReceiptSchema>;

/** Sum of priced receipts, in attempt order. The single definition of spend. */
export function spendOf(attempts: readonly Pick<Receipt, "cost_usd">[]): number {
  return attempts.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0);
}

export function unpricedCountOf(attempts: readonly Pick<Receipt, "cost_usd">[]): number {
  return attempts.filter((entry) => entry.cost_usd === null).length;
}

/** Outcomes that can only follow a reply the provider actually returned. */
const REPLY_OUTCOMES = new Set(["OK", "SCHEMA_INVALID", "OUTPUT_TRUNCATED"]);

function receiptViolations(receipt: Receipt): string[] {
  const violations: string[] = [];
  const label = `attempt ${receipt.attempt_id} (${receipt.operation} ${receipt.attempt})`;
  if (!receipt.dispatched) {
    if (receipt.cost_usd !== 0) {
      violations.push(`${label} was never dispatched but records cost ${receipt.cost_usd}`);
    }
    if (REPLY_OUTCOMES.has(receipt.outcome)) {
      violations.push(`${label} was never dispatched but records outcome ${receipt.outcome}`);
    }
  } else if (
    receipt.outcome === "SPEND_CAP_REFUSED" ||
    receipt.outcome === "PROVIDER_NOT_CONFIGURED"
  ) {
    violations.push(`${label} was dispatched but records refusal outcome ${receipt.outcome}`);
  }
  if (
    receipt.reasoning_tokens !== null &&
    receipt.completion_tokens !== null &&
    receipt.reasoning_tokens > receipt.completion_tokens
  ) {
    violations.push(`${label} reports more reasoning tokens than completion tokens`);
  }
  return violations;
}

/**
 * Validate the document. Shape first (strict), then the invariants. Every
 * counter and the spend total are recomputed from the receipts.
 */
export function assertProviderAttempts(value: unknown): ProviderAttemptsV1 {
  const parsed = providerAttemptsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderAttemptsInvalidError(
      `provider attempts do not satisfy ${PROVIDER_ATTEMPTS_SCHEMA}`,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  const document = parsed.data;
  const violations: string[] = [];
  if (document.attempt_count !== document.attempts.length) {
    violations.push(
      `attempt_count is ${document.attempt_count} but ${document.attempts.length} receipt(s) were recorded`,
    );
  }
  const spend = spendOf(document.attempts);
  if (Math.abs(document.spend_usd - spend) > SPEND_EPSILON) {
    violations.push(`spend_usd is ${document.spend_usd} but the attempt receipts sum to ${spend}`);
  }
  const unpriced = unpricedCountOf(document.attempts);
  if (document.unpriced_attempt_count !== unpriced) {
    violations.push(
      `unpriced_attempt_count is ${document.unpriced_attempt_count} but ${unpriced} receipt(s) have no cost`,
    );
  }
  const seen = new Set<string>();
  for (const receipt of document.attempts) {
    if (seen.has(receipt.attempt_id)) violations.push(`duplicate attempt_id ${receipt.attempt_id}`);
    seen.add(receipt.attempt_id);
    violations.push(...receiptViolations(receipt));
  }
  if (violations.length > 0) {
    throw new ProviderAttemptsInvalidError(
      "provider attempts contradict the receipts they carry",
      violations,
    );
  }
  return document;
}
