/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * INTEL-SCORE-001 — deterministic ranking.
 *
 * The scorer's contract is that its output is a pure function of the stored
 * signals. Everything below either pins that (same input, same number, twice)
 * or pins one of the exclusions that decide WHICH signals count: suppressed,
 * stale, or already clustered.
 */

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  makeConfig,
  resetTables,
  schema,
  seedClient,
  silentLogger,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let pg: PGlite;
let configOptions: Parameters<typeof makeConfig>[0] = { INTELLIGENCE_MODE: "observe" };

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => db,
  get schema() {
    return schema;
  },
}));
vi.mock("../../../src/core/logger.js", () => silentLogger);
vi.mock("../../../src/core/config.js", () => ({
  getConfig: () => makeConfig(configOptions),
}));

import {
  computeScore,
  isStale,
  scoreOpportunities,
} from "../../../src/modules/intelligence/opportunity-scorer.js";

let clientA: string;
let clientB: string;
const NOW = new Date("2026-08-31T12:00:00Z");

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  configOptions = { INTELLIGENCE_MODE: "observe" };
  await resetTables(pg);
  clientA = await seedClient(db, { domain: "client-a.test" });
  clientB = await seedClient(db, { domain: "client-b.test" });
});

afterEach(() => {
  vi.clearAllMocks();
});

interface SignalFixture {
  clientId: string;
  signalType: string;
  fingerprint: string;
  severity?: string;
  subject: string;
  status?: string;
  observedAt?: Date;
}

async function insertSignal(fixture: SignalFixture): Promise<void> {
  await db.insert(schema.intelligenceSignals).values({
    clientId: fixture.clientId,
    signalType: fixture.signalType,
    fingerprint: fixture.fingerprint,
    severity: fixture.severity ?? "warning",
    subject: fixture.subject,
    evidence: {},
    status: fixture.status ?? "open",
    firstObservedAt: fixture.observedAt ?? NOW,
    observedAt: fixture.observedAt ?? NOW,
  });
}

describe("computeScore", () => {
  it("ranks high impact + high confidence + low effort above its opposite", () => {
    const strong = computeScore({ impact: 0.9, confidence: 0.9, effort: 0.1, risk: 0.1 });
    const weak = computeScore({ impact: 0.9, confidence: 0.2, effort: 0.9, risk: 0.8 });
    expect(strong).toBeGreaterThan(weak);
  });

  it("lets risk veto a large claimed impact", () => {
    // The (1 − risk) factor is a multiplier, not a subtraction, so maximum
    // risk zeroes the score however big the upside is claimed to be.
    expect(computeScore({ impact: 1, confidence: 1, effort: 0, risk: 1 })).toBe(0);
  });

  it("scores low confidence below high confidence, all else equal", () => {
    const certain = computeScore({ impact: 0.6, confidence: 0.9, effort: 0.4, risk: 0.2 });
    const uncertain = computeScore({ impact: 0.6, confidence: 0.2, effort: 0.4, risk: 0.2 });
    expect(certain).toBeGreaterThan(uncertain);
  });

  it("is bounded to 0..100 and reproducible", () => {
    const args = { impact: 1, confidence: 1, effort: 0, risk: 0 };
    expect(computeScore(args)).toBeLessThanOrEqual(100);
    expect(computeScore(args)).toBe(computeScore(args));
    // Out-of-range inputs are clamped rather than propagated.
    expect(computeScore({ impact: 5, confidence: 5, effort: -3, risk: -1 })).toBeLessThanOrEqual(
      100,
    );
  });
});

describe("isStale", () => {
  it("is false inside the TTL and true outside it", () => {
    const observed = new Date(NOW.getTime() - 10 * 3_600_000);
    expect(isStale(observed, NOW, 72)).toBe(false);
    expect(isStale(observed, NOW, 4)).toBe(true);
  });
});

describe("scoreOpportunities", () => {
  it("maps each signal type onto its opportunity type", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "fp-lcp",
      subject: "/slow",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "citation_loss",
      fingerprint: "fp-cite",
      subject: "perplexity:q",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "prospect_ready",
      fingerprint: "fp-link",
      subject: "https://p.test",
    });

    const opportunities = await scoreOpportunities(clientA, { now: NOW });
    expect(opportunities.map((o) => o.opportunityType).sort()).toEqual([
      "fix_page_experience",
      "pursue_link_prospect",
      "recover_keyword_position",
      "regain_answer_citation",
    ]);
  });

  it("returns opportunities ordered by score, highest first", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
      severity: "critical",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "prospect_ready",
      fingerprint: "fp-link",
      subject: "https://p.test",
      severity: "info",
    });

    const opportunities = await scoreOpportunities(clientA, { now: NOW });
    expect(opportunities[0].opportunityType).toBe("recover_keyword_position");
    // Outreach carries the highest risk weight in the table, so it has to
    // out-argue the others rather than winning on novelty.
    expect(opportunities.at(-1)?.opportunityType).toBe("pursue_link_prospect");
  });

  it("is reproducible across runs", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
    });
    const first = await scoreOpportunities(clientA, { now: NOW });
    const second = await scoreOpportunities(clientA, { now: NOW });
    expect(second[0].score).toBe(first[0].score);
    expect(second[0].fingerprint).toBe(first[0].fingerprint);
  });

  it("ignores suppressed signals", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
      status: "suppressed",
    });
    expect(await scoreOpportunities(clientA, { now: NOW })).toHaveLength(0);
  });

  it("ignores stale signals", async () => {
    configOptions = { INTELLIGENCE_MODE: "observe", INTELLIGENCE_SIGNAL_TTL_HOURS: 24 };
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-old",
      subject: "roofing",
      observedAt: new Date(NOW.getTime() - 96 * 3_600_000),
    });
    // Acting on a four-day-old drop that may have already recovered spends
    // budget on a problem that no longer exists.
    expect(await scoreOpportunities(clientA, { now: NOW })).toHaveLength(0);
  });

  it("collapses a duplicate signal cluster into one opportunity", async () => {
    // Two readings about the same page. One job to do, not two.
    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "fp-1",
      subject: "/slow",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "fp-2",
      subject: "/slow",
    });

    const opportunities = await scoreOpportunities(clientA, { now: NOW });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].signalFingerprints).toEqual(["fp-1", "fp-2"]);
  });

  it("raises confidence when signals corroborate, with a ceiling", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "s1",
      subject: "/one",
    });
    const [single] = await scoreOpportunities(clientA, { now: NOW });

    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "s2",
      subject: "/two",
    });
    await insertSignal({
      clientId: clientA,
      signalType: "bad_lcp_high_exit",
      fingerprint: "s3",
      subject: "/two",
    });
    const opportunities = await scoreOpportunities(clientA, { now: NOW });
    const paired = opportunities.find((o) => o.signalFingerprints.length === 2);

    expect(paired?.confidence).toBeGreaterThan(single.confidence);
    expect(paired?.confidence).toBeLessThanOrEqual(1);
  });

  it("writes one row per opportunity and updates it on re-score", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
    });
    await scoreOpportunities(clientA, { now: NOW });
    await scoreOpportunities(clientA, { now: new Date(NOW.getTime() + 3_600_000) });

    const rows = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(eq(schema.intelligenceOpportunities.clientId, clientA));
    expect(rows).toHaveLength(1);
  });

  it("does not reopen an opportunity that was already routed", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "fp-kw",
      subject: "roofing",
    });
    await scoreOpportunities(clientA, { now: NOW });
    await db
      .update(schema.intelligenceOpportunities)
      .set({ status: "routed" })
      .where(eq(schema.intelligenceOpportunities.clientId, clientA));

    await scoreOpportunities(clientA, { now: new Date(NOW.getTime() + 3_600_000) });

    const rows = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(eq(schema.intelligenceOpportunities.clientId, clientA));
    // Reopening it would re-route the same work on every cycle.
    expect(rows[0].status).toBe("routed");
  });

  it("never reads another client's signals", async () => {
    await insertSignal({
      clientId: clientB,
      signalType: "keyword_drop",
      fingerprint: "fp-b",
      subject: "roofing",
    });
    expect(await scoreOpportunities(clientA, { now: NOW })).toHaveLength(0);

    const rowsA = await db
      .select()
      .from(schema.intelligenceOpportunities)
      .where(eq(schema.intelligenceOpportunities.clientId, clientA));
    expect(rowsA).toHaveLength(0);
  });

  it("gives two clients with identical signals different opportunity fingerprints", async () => {
    await insertSignal({
      clientId: clientA,
      signalType: "keyword_drop",
      fingerprint: "same-fp",
      subject: "roofing",
    });
    await insertSignal({
      clientId: clientB,
      signalType: "keyword_drop",
      fingerprint: "same-fp",
      subject: "roofing",
    });

    const [a] = await scoreOpportunities(clientA, { now: NOW });
    const [b] = await scoreOpportunities(clientB, { now: NOW });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("throws rather than scoring without a client id", async () => {
    await expect(scoreOpportunities("", { now: NOW })).rejects.toThrow(/clientId is required/);
  });
});
