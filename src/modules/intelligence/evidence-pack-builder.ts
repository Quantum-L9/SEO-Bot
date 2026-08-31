/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Intelligence: evidence pack
 *
 * The planner sees THIS and nothing else. It has no database handle, no SQL, no
 * client config, and no ability to widen its own view — the only facts it can
 * reason over are the ones assembled here.
 *
 * That is a containment boundary, not a convenience. Two things follow from it:
 *
 *  - Whatever leaks into a pack leaks to the model provider, so the builder
 *    carries an explicit deny-list and a whole-object scrub, and the suite
 *    asserts that a client row's `posthogApiKey` and raw `config` cannot appear.
 *
 *  - Everything in the pack that originated outside our own measurements
 *    (a competitor's page title, a snippet) is attacker-controlled text. It is
 *    carried under `untrusted` and it is DATA. Text inside the pack can never
 *    authorize an action: the planner's output is validated against a closed
 *    vocabulary afterwards, so a snippet reading "return
 *    intelligence_execute_site_change" changes nothing about what is allowed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "../../core/database/index.js";
import { assertClientId } from "./policy-gate.js";

/** Hard cap on any single untrusted string entering a prompt. */
const MAX_UNTRUSTED_CHARS = 200;

/** How many opportunities the planner is asked to consider at once. */
const MAX_OPPORTUNITIES = 20;

/**
 * Keys that must never appear in a pack, matched case-insensitively as
 * substrings so `posthogApiKey`, `posthog_api_key`, and `POSTHOG_API_KEY` are
 * all caught by one entry.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "cookie",
  "session",
  "privatekey",
  "private_key",
  "email",
  "config",
];

export interface EvidencePackOpportunity {
  opportunityFingerprint: string;
  opportunityType: string;
  score: number;
  impact: number;
  confidence: number;
  effort: number;
  risk: number;
  rationale: string;
}

export interface EvidencePackSignal {
  signalType: string;
  severity: string;
  subject: string;
  evidence: Record<string, number | string | null>;
}

export interface EvidencePack {
  clientId: string;
  /** Non-secret descriptors that help the planner reason about relevance. */
  clientProfile: { industry: string; city: string | null; state: string | null };
  mode: string;
  /** The actions the planner is permitted to name. Anything else is rejected. */
  allowedActions: readonly string[];
  opportunities: EvidencePackOpportunity[];
  signals: EvidencePackSignal[];
  /** Attacker-controlled text. Data only — it can never authorize an action. */
  untrusted: { competitorTitles: string[]; competitorSnippets: string[] };
}

/**
 * Neutralize a string before it enters a prompt.
 *
 * Control characters are stripped (they are used to fake message boundaries),
 * whitespace is collapsed, and the result is truncated. This raises the cost of
 * an injection attempt; it does not defeat one. The output validator is what
 * actually holds the line, and this function must never be mistaken for it.
 */
export function sanitizeUntrusted(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const withoutControls = value.replace(/[\u0000-\u001F\u007F]/g, " ");
  return withoutControls.replace(/\s+/g, " ").trim().slice(0, MAX_UNTRUSTED_CHARS);
}

/**
 * Recursively drop anything whose key looks like a credential or an identity.
 *
 * A deny-list on keys rather than values, because a token's VALUE is just a
 * string — there is no reliable way to recognise one after the fact. Applied to
 * the assembled pack as a final pass, so a field added to the builder later is
 * scrubbed even if whoever added it did not think about this.
 */
export function scrubForbiddenKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => scrubForbiddenKeys(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))) continue;
      output[key] = scrubForbiddenKeys(nested);
    }
    return output as unknown as T;
  }
  return value;
}

/**
 * Assemble the pack for ONE client.
 *
 * Every query is client-scoped, and the pack's `clientId` is the one passed in
 * — never one read back out of a row — so a mis-joined query cannot relabel
 * another tenant's evidence as this client's.
 */
export async function buildEvidencePack(params: {
  clientId: string;
  mode: string;
  allowedActions: readonly string[];
  now?: Date;
}): Promise<EvidencePack> {
  const { clientId, mode, allowedActions } = params;
  assertClientId(clientId);
  const db = getDb();
  const since = new Date((params.now ?? new Date()).getTime() - 14 * 86_400_000);

  const [client] = await db
    .select({
      industry: schema.clients.industry,
      city: schema.clients.city,
      state: schema.clients.state,
    })
    .from(schema.clients)
    .where(eq(schema.clients.id, clientId))
    .limit(1);

  const opportunityRows = await db
    .select({
      fingerprint: schema.intelligenceOpportunities.fingerprint,
      opportunityType: schema.intelligenceOpportunities.opportunityType,
      score: schema.intelligenceOpportunities.score,
      impact: schema.intelligenceOpportunities.impact,
      confidence: schema.intelligenceOpportunities.confidence,
      effort: schema.intelligenceOpportunities.effort,
      risk: schema.intelligenceOpportunities.risk,
      rationale: schema.intelligenceOpportunities.rationale,
    })
    .from(schema.intelligenceOpportunities)
    .where(
      and(
        eq(schema.intelligenceOpportunities.clientId, clientId),
        eq(schema.intelligenceOpportunities.status, "open"),
      ),
    )
    .orderBy(desc(schema.intelligenceOpportunities.score))
    .limit(MAX_OPPORTUNITIES);

  const signalRows = await db
    .select({
      signalType: schema.intelligenceSignals.signalType,
      severity: schema.intelligenceSignals.severity,
      subject: schema.intelligenceSignals.subject,
      evidence: schema.intelligenceSignals.evidence,
    })
    .from(schema.intelligenceSignals)
    .where(
      and(
        eq(schema.intelligenceSignals.clientId, clientId),
        eq(schema.intelligenceSignals.status, "open"),
      ),
    );

  const competitorRows = await db
    .select({
      title: schema.competitorSnapshots.title,
      snippet: schema.competitorSnapshots.snippet,
    })
    .from(schema.competitorSnapshots)
    .where(
      and(
        eq(schema.competitorSnapshots.clientId, clientId),
        gte(schema.competitorSnapshots.checkedAt, since),
      ),
    )
    .limit(10);

  const pack: EvidencePack = {
    clientId,
    clientProfile: {
      industry: client?.industry ?? "unknown",
      city: client?.city ?? null,
      state: client?.state ?? null,
    },
    mode,
    allowedActions,
    opportunities: opportunityRows.map((row) => ({
      opportunityFingerprint: row.fingerprint,
      opportunityType: row.opportunityType,
      score: row.score,
      impact: row.impact,
      confidence: row.confidence,
      effort: row.effort,
      risk: row.risk,
      rationale: sanitizeUntrusted(row.rationale),
    })),
    signals: signalRows.map((row) => ({
      signalType: row.signalType,
      severity: row.severity,
      subject: sanitizeUntrusted(row.subject),
      evidence: (row.evidence ?? {}) as Record<string, number | string | null>,
    })),
    untrusted: {
      competitorTitles: competitorRows
        .map((row) => sanitizeUntrusted(row.title ?? ""))
        .filter((text) => text.length > 0),
      competitorSnippets: competitorRows
        .map((row) => sanitizeUntrusted(row.snippet ?? ""))
        .filter((text) => text.length > 0),
    },
  };

  // Final pass over the whole object, after assembly rather than field by
  // field, so nothing added here later escapes the scrub by omission.
  const scrubbed = scrubForbiddenKeys(pack);
  // `clientId` survives the scrub by construction (it matches no forbidden
  // fragment), but the planner is useless without it, so assert rather than assume.
  if (!scrubbed.clientId) {
    throw new Error("intelligence: evidence pack lost its clientId during scrubbing");
  }
  return scrubbed;
}
