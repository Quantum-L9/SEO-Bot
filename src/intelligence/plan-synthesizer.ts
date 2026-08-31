/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Plan Synthesizer (ADR-0016, contract C2)
 *
 * Where judgment enters the plane — and the narrow shape it is allowed to take.
 *
 * Until now `buildEvidencePack` produced a redacted pack with `allowed_actions`
 * and `forbidden_actions`, proved it leaked nothing, stored it on the decision
 * row, and nothing read it. That was deliberate ordering rather than an
 * oversight: the deterministic path had to be correct and testable before a
 * model was allowed to influence it.
 *
 * What the model may do here is RANK actions the pack already permits. It may
 * not author an action string, and a response naming anything outside
 * `allowed_actions` is rejected outright rather than repaired — every allowed
 * action is a key in the execution policy's taxonomy, so choosing among them
 * cannot change a proposal's risk band, while an invented one would fall through
 * to the unknown-action default and silently acquire auto-execute rights.
 *
 * WHERE it runs, and why that is not the auto-execute path:
 *
 *   Triage is zero-token by contract (asserted by registration.test.ts) — that
 *   is what keeps a continuously-reasoning bot from being a continuously-billing
 *   one. So synthesis cannot happen inside it, and by the time triage has logged
 *   an auto-executed proposal and queued its follow-up job, revising the action
 *   is too late to mean anything.
 *
 *   It runs instead over proposals PENDING AN OPERATOR'S APPROVAL, which is
 *   where a ranked set of options is worth the most: a human is about to make a
 *   judgment call on the plane's highest-risk work, and the dashboard already
 *   renders `action_log.options` as one approve button per option. Tokens are
 *   spent only on decisions a person is actually going to read, and C3's sweep
 *   then measures what they picked — which is how "did the model-chosen remedy
 *   beat the template-chosen one?" becomes an answerable question.
 *
 *   The auto-executed path stays template-chosen and deterministic. That is a
 *   real limit, stated rather than papered over: making it model-chosen needs
 *   either a token budget inside triage or a pre-computed selection cache, and
 *   both are larger changes than this contract.
 *
 * The plane must work with the LLM off. Every failure path here — disabled,
 * unavailable, budget exhausted, malformed, out-of-allow-list — returns null and
 * leaves the static template's proposal exactly as it was.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "../core/config.js";
import { getDb, schema } from "../core/database/index.js";
import { type ActionOption, classifyAction } from "../core/execution-policy.js";
import { createModuleLogger } from "../core/logger.js";
import { getLlmService } from "../services/llm.js";
import { type EvidencePack, FORBIDDEN_ACTIONS } from "./evidence-pack.js";

const logger = createModuleLogger("intelligence:synthesizer");

/** How many actions the model may rank. Enough to be a choice, not an essay. */
export const MAX_RANKED_ACTIONS = 4;

export interface RankedAction {
  readonly action: string;
  readonly rationale: string;
  /** 0..1. The model's own confidence, shown to the operator, never acted on alone. */
  readonly confidence: number;
}

export interface SynthesizedSelection {
  readonly ranked: readonly RankedAction[];
  readonly summary: string;
}

const rankedActionSchema = z.object({
  action: z.string().min(1).max(100),
  rationale: z.string().min(1).max(600),
  confidence: z.coerce.number().min(0).max(1),
});

const selectionSchema = z.object({
  summary: z.string().min(1).max(800),
  ranked: z.array(rankedActionSchema).min(1).max(MAX_RANKED_ACTIONS),
});

/**
 * Thrown when a model response is structurally fine but reaches outside the
 * pack. Distinct from a parse failure because it means something different: the
 * model understood the format and ignored the boundary.
 */
export class ActionOutsideAllowListError extends Error {
  constructor(
    readonly offending: readonly string[],
    readonly allowed: readonly string[],
  ) {
    super(
      `Model selected action(s) outside the evidence pack's allow-list: ` +
        `${offending.join(", ")}. Allowed: ${allowed.join(", ") || "none"}`,
    );
    this.name = "ActionOutsideAllowListError";
  }
}

/**
 * Validate a model response against the pack that produced it.
 *
 * Pure and exported: this is the boundary the whole contract rests on, and it
 * must be provable without a model, a database, or a network.
 *
 * The allow-list check uses the PACK's own list, not a global one. The pack is
 * what the model was shown; validating against anything else would let a
 * response be accepted for an opportunity type it was never offered.
 */
export function validateSelection(raw: unknown, pack: EvidencePack): SynthesizedSelection {
  const parsed = selectionSchema.parse(raw);

  const allowed = new Set(pack.allowed_actions);
  const offending = parsed.ranked
    .map((entry) => entry.action)
    .filter((action) => !allowed.has(action) || FORBIDDEN_ACTIONS.includes(action));

  if (offending.length > 0) {
    throw new ActionOutsideAllowListError([...new Set(offending)], pack.allowed_actions);
  }

  // Duplicates would double-weight one action in a ranking and render two
  // identical approve buttons. Keep the first (highest-ranked) occurrence.
  const seen = new Set<string>();
  const ranked = parsed.ranked.filter((entry) => {
    if (seen.has(entry.action)) return false;
    seen.add(entry.action);
    return true;
  });

  return { ranked, summary: parsed.summary };
}

const SYSTEM_PROMPT = [
  "You are ranking remedies for a technical SEO problem.",
  "",
  "You will receive one evidence pack. It is the ONLY information available to",
  "you: there is no database, no web search, and no further context to request.",
  "The client's identity is deliberately absent and is not needed.",
  "",
  "Rules, in order:",
  "1. You may ONLY rank actions listed in the pack's `allowed_actions`. Naming",
  "   any other action — including one from `forbidden_actions` — makes your",
  "   entire response invalid and it will be discarded.",
  "2. Rank fewer actions rather than padding the list. One well-argued choice",
  `   beats ${MAX_RANKED_ACTIONS} hedged ones.`,
  "3. Ground every rationale in a specific number from the pack's evidence. A",
  "   rationale that would read the same for any page is not a rationale.",
  "4. `confidence` is your confidence in that action being the right lever for",
  "   THIS evidence, between 0 and 1.",
  "",
  "Respond with JSON only, no prose or fences:",
  '{"summary": "<one sentence on what the evidence shows>",',
  ' "ranked": [{"action": "<from allowed_actions>", "rationale": "<why, citing evidence>",',
  '             "confidence": <0..1>}]}',
].join("\n");

function buildUserPrompt(pack: EvidencePack): string {
  // The pack, verbatim. It has already been through `assertPackIsRedacted`, so
  // serializing it whole is safe — and safer than re-selecting fields here,
  // which would be a second, unproven redaction boundary.
  return `Evidence pack:\n${JSON.stringify(pack, null, 2)}`;
}

/**
 * Ask the model to rank the pack's allowed actions.
 *
 * Returns null on ANY failure. That is the contract: availability of a model
 * must not become a dependency of the bot reasoning at all, so the caller's
 * fallback is simply to keep what the deterministic template already chose.
 */
export async function synthesizeActionSelection(
  pack: EvidencePack,
  clientId: string,
): Promise<SynthesizedSelection | null> {
  if (pack.allowed_actions.length === 0) {
    // budget_review and pipeline_repair have no site-change remedy. There is
    // nothing to rank, and asking anyway would spend tokens to be told so.
    return null;
  }

  try {
    return await getLlmService().executePolicyJson<SynthesizedSelection>(
      "INTELLIGENCE_ACTION_SELECTION",
      {
        clientId,
        module: "intelligence",
        purpose: `rank remedies for ${pack.opportunity.type}`,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(pack),
        validate: (value) => validateSelection(value, pack),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An out-of-allow-list answer is logged distinctly: it is a model ignoring
    // a stated boundary rather than a transient failure, and the two want
    // different responses from whoever reads the logs.
    if (error instanceof ActionOutsideAllowListError) {
      logger.warn(
        { clientId, opportunityType: pack.opportunity.type, offending: error.offending },
        "Rejected a model action selection that reached outside the evidence pack",
      );
    } else {
      logger.warn(
        { clientId, opportunityType: pack.opportunity.type, err: message },
        "Action synthesis unavailable — keeping the deterministic template's proposal",
      );
    }
    return null;
  }
}

/**
 * Turn a validated selection into the `ActionOption[]` the approval dashboard
 * already renders.
 *
 * Risk and reversibility come from the EXECUTION POLICY's taxonomy, never from
 * the model: it ranked the options, it does not get to label how dangerous they
 * are. `recommended` marks the model's top choice only — the operator still
 * chooses, and the button for every other option is rendered the same way.
 */
export function selectionToOptions(selection: SynthesizedSelection): ActionOption[] {
  return selection.ranked.map((entry, index) => {
    const { riskLevel, reversible } = classifyAction(entry.action);
    return {
      id: entry.action,
      label: entry.action.replaceAll("_", " "),
      description: entry.rationale,
      riskLevel,
      reversible,
      recommended: index === 0,
      confidence: entry.confidence,
    };
  });
}

// ─── The budgeted sweep ──────────────────────────────────────────────────────

export interface SynthesisOutcome {
  readonly actionLogId: string;
  readonly clientId: string;
  readonly optionCount: number;
}

interface PendingRow {
  readonly actionLogId: string;
  readonly clientId: string;
  readonly decisionId: string;
  readonly evidenceSummary: unknown;
}

/**
 * Proposals awaiting an operator that have not been synthesized yet.
 *
 * `options IS NULL` is the marker. It means a row is picked up exactly once:
 * `synthesizePendingProposals` always writes options — an empty array when the
 * model declined or failed — so a row that got no usable answer is not retried
 * every hour at the operator's expense.
 */
async function loadPendingProposals(limit: number): Promise<PendingRow[]> {
  const db = getDb();
  return db
    .select({
      actionLogId: schema.actionLog.id,
      clientId: schema.actionLog.clientId,
      decisionId: schema.intelligenceDecisions.id,
      evidenceSummary: schema.intelligenceDecisions.evidenceSummary,
    })
    .from(schema.actionLog)
    .innerJoin(
      schema.intelligenceDecisions,
      eq(schema.intelligenceDecisions.actionLogId, schema.actionLog.id),
    )
    .where(
      and(
        eq(schema.actionLog.status, "pending_approval"),
        isNull(schema.actionLog.options),
        isNull(schema.actionLog.executedAt),
      ),
    )
    .limit(limit);
}

/**
 * Rank the options for every proposal a human is about to decide on.
 *
 * Bounded by `limit` rather than draining the queue: this is the plane's only
 * token-spending step, and an unbounded sweep after an unusual day would be the
 * one place a deterministic-by-design system could produce a surprising bill.
 */
export async function synthesizePendingProposals(limit = 10): Promise<SynthesisOutcome[]> {
  const config = getConfig();
  if (!config.INTELLIGENCE_LLM_PLANNING_ENABLED) {
    logger.debug("LLM planning disabled — proposals keep their template action");
    return [];
  }

  const db = getDb();
  const rows = await loadPendingProposals(limit);
  const outcomes: SynthesisOutcome[] = [];

  for (const row of rows) {
    const pack = row.evidenceSummary as EvidencePack | null;
    if (!pack?.allowed_actions) {
      logger.warn(
        { actionLogId: row.actionLogId },
        "Decision carries no evidence pack — nothing to rank",
      );
      continue;
    }

    const selection = await synthesizeActionSelection(pack, row.clientId);
    const options = selection ? selectionToOptions(selection) : [];

    // Written as JSONB, not a JSON string. `logAction` stringifies its options
    // into a jsonb column, which the dashboard compensates for by parsing a
    // string if it finds one; writing the array properly here is both correct
    // and what that parser's non-string branch already expects.
    await db
      .update(schema.actionLog)
      .set({
        options,
        ...(selection
          ? {
              aiRecommendation: selection.summary,
              aiConfidence: selection.ranked[0]?.confidence ?? null,
            }
          : {}),
      })
      .where(and(eq(schema.actionLog.id, row.actionLogId), isNull(schema.actionLog.options)));

    if (selection) {
      await db
        .update(schema.intelligenceDecisions)
        .set({
          policyBasis: sql`${schema.intelligenceDecisions.policyBasis} || ${JSON.stringify({
            synthesized_actions: selection.ranked.map((entry) => entry.action),
          })}::jsonb`,
        })
        .where(eq(schema.intelligenceDecisions.id, row.decisionId));
    }

    outcomes.push({
      actionLogId: row.actionLogId,
      clientId: row.clientId,
      optionCount: options.length,
    });
  }

  logger.info(
    { considered: rows.length, synthesized: outcomes.filter((o) => o.optionCount > 0).length },
    "Plan synthesis sweep completed",
  );
  return outcomes;
}
