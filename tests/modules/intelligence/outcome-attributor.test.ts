/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * INTEL-OUTCOME-001 — measuring honestly.
 *
 * The attributor's failure mode is not a wrong number, it is a flattering one.
 * A missing post-action reading scored as a success would teach the loop that
 * doing nothing works, and that mistake compounds every cycle. So the tests
 * that matter here are the ones asserting `success` stays NULL rather than
 * becoming `true`.
 */

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../../src/core/database/index.js", () => ({
  getDb: () => db,
  get schema() {
    return schema;
  },
}));
vi.mock("../../../src/core/logger.js", () => silentLogger);
vi.mock("../../../src/core/config.js", () => ({
  getConfig: () => makeConfig({ INTELLIGENCE_MODE: "route_safe" }),
}));

import { attributeOutcomes } from "../../../src/modules/intelligence/outcome-attributor.js";

let clientA: string;
let clientB: string;
const NOW = new Date("2026-08-31T12:00:00Z");
/** Ten days back — past the seven-day maturation window. */
const MATURED = new Date(NOW.getTime() - 10 * 86_400_000);
/** Two days back — still maturing. */
const FRESH = new Date(NOW.getTime() - 2 * 86_400_000);

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  await resetTables(pg);
  clientA = await seedClient(db, { domain: "client-a.test" });
  clientB = await seedClient(db, { domain: "client-b.test" });
});

/**
 * Seed a routed keyword opportunity whose signal recorded `positionBefore`,
 * optionally with a later SERP reading to compare against.
 */
async function seedRoutedKeyword(params: {
  clientId: string;
  keyword: string;
  positionBefore: number;
  linkedAt: Date;
  positionAfter?: number;
  signalFingerprint?: string;
}): Promise<void> {
  const fingerprint = params.signalFingerprint ?? `sig-${params.keyword}`;

  await db.insert(schema.intelligenceSignals).values({
    clientId: params.clientId,
    signalType: "keyword_drop",
    fingerprint,
    severity: "critical",
    subject: params.keyword,
    evidence: { currentPosition: params.positionBefore, previousPosition: 3 },
    status: "open",
    firstObservedAt: params.linkedAt,
    observedAt: params.linkedAt,
  });

  const [opportunity] = await db
    .insert(schema.intelligenceOpportunities)
    .values({
      clientId: params.clientId,
      opportunityType: "recover_keyword_position",
      fingerprint: `opp-${params.keyword}`,
      score: 50,
      impact: 0.9,
      confidence: 0.8,
      effort: 0.4,
      risk: 0.2,
      status: "routed",
      signalFingerprints: [fingerprint],
      rationale: "test",
      createdAt: params.linkedAt,
      updatedAt: params.linkedAt,
    })
    .returning({ id: schema.intelligenceOpportunities.id });

  await db.insert(schema.intelligenceActionLinks).values({
    clientId: params.clientId,
    opportunityId: opportunity.id,
    jobName: "serp:generate-surpass-plan",
    jobId: `intel:${params.keyword}`,
    linkedAt: params.linkedAt,
  });

  if (params.positionAfter !== undefined) {
    await db.insert(schema.serpRankings).values({
      clientId: params.clientId,
      keyword: params.keyword,
      position: params.positionAfter,
      previousPosition: params.positionBefore,
      // After the routing, so it counts as a post-action reading.
      checkedAt: new Date(params.linkedAt.getTime() + 3 * 86_400_000),
    });
  }
}

describe("attribution", () => {
  it("records an improvement as a success", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "metal roofing",
      positionBefore: 11,
      positionAfter: 4,
      linkedAt: MATURED,
    });

    const outcomes = await attributeOutcomes(clientA, { now: NOW });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].positionBefore).toBe(11);
    expect(outcomes[0].positionAfter).toBe(4);
    // A LOWER position number is better — the direction is easy to invert.
    expect(outcomes[0].success).toBe(true);
  });

  it("records a further decline as a failure", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "gutters",
      positionBefore: 11,
      positionAfter: 19,
      linkedAt: MATURED,
    });
    const [outcome] = await attributeOutcomes(clientA, { now: NOW });
    expect(outcome.success).toBe(false);
  });

  it("records no change as a failure rather than a success", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "siding",
      positionBefore: 11,
      positionAfter: 11,
      linkedAt: MATURED,
    });
    const [outcome] = await attributeOutcomes(clientA, { now: NOW });
    expect(outcome.success).toBe(false);
  });

  it("leaves success NULL when there is no post-action reading", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "flat roof",
      positionBefore: 11,
      linkedAt: MATURED,
    });
    const [outcome] = await attributeOutcomes(clientA, { now: NOW });
    // Unmeasurable is not successful. Scoring it as a win would teach the loop
    // that doing nothing works.
    expect(outcome.positionAfter).toBeNull();
    expect(outcome.success).toBeNull();
  });

  it("leaves success NULL for an opportunity type with no comparable metric", async () => {
    const [opportunity] = await db
      .insert(schema.intelligenceOpportunities)
      .values({
        clientId: clientA,
        opportunityType: "pursue_link_prospect",
        fingerprint: "opp-link",
        score: 20,
        impact: 0.5,
        confidence: 0.5,
        effort: 0.7,
        risk: 0.5,
        status: "routed",
        signalFingerprints: ["sig-link"],
        rationale: "test",
        createdAt: MATURED,
        updatedAt: MATURED,
      })
      .returning({ id: schema.intelligenceOpportunities.id });

    await db.insert(schema.intelligenceSignals).values({
      clientId: clientA,
      signalType: "prospect_ready",
      fingerprint: "sig-link",
      severity: "info",
      subject: "https://p.test",
      evidence: {},
      status: "open",
      firstObservedAt: MATURED,
      observedAt: MATURED,
    });

    await db.insert(schema.intelligenceActionLinks).values({
      clientId: clientA,
      opportunityId: opportunity.id,
      jobName: "links:process-outreach",
      jobId: "intel:link",
      linkedAt: MATURED,
    });

    const [outcome] = await attributeOutcomes(clientA, { now: NOW });
    // No fabricated proxy metric stands in for a measurement we do not have.
    expect(outcome.success).toBeNull();
  });
});

describe("windowing", () => {
  it("ignores a routing that has not matured yet", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "too soon",
      positionBefore: 11,
      positionAfter: 3,
      linkedAt: FRESH,
    });
    expect(await attributeOutcomes(clientA, { now: NOW })).toHaveLength(0);
  });

  it("ignores a routing older than the maximum age", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "ancient",
      positionBefore: 11,
      positionAfter: 3,
      linkedAt: new Date(NOW.getTime() - 120 * 86_400_000),
    });
    expect(await attributeOutcomes(clientA, { now: NOW })).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("writes an action_outcomes row attributed to the intelligence module", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "metal roofing",
      positionBefore: 11,
      positionAfter: 4,
      linkedAt: MATURED,
    });
    await attributeOutcomes(clientA, { now: NOW });

    const rows = await db
      .select()
      .from(schema.actionOutcomes)
      .where(eq(schema.actionOutcomes.clientId, clientA));
    expect(rows).toHaveLength(1);
    expect(rows[0].module).toBe("intelligence");
    expect(rows[0].success).toBe(true);
    // The record says what it is: an observed delta, not a proven cause.
    expect(rows[0].learnings).toContain("Correlation only");
  });
});

describe("tenant isolation", () => {
  it("attributes only the requested client's routings", async () => {
    await seedRoutedKeyword({
      clientId: clientB,
      keyword: "metal roofing",
      positionBefore: 11,
      positionAfter: 2,
      linkedAt: MATURED,
    });
    expect(await attributeOutcomes(clientA, { now: NOW })).toHaveLength(0);

    const rows = await db
      .select()
      .from(schema.actionOutcomes)
      .where(eq(schema.actionOutcomes.clientId, clientA));
    expect(rows).toHaveLength(0);
  });

  it("does not read another client's SERP readings for the same keyword", async () => {
    await seedRoutedKeyword({
      clientId: clientA,
      keyword: "shared keyword",
      positionBefore: 11,
      linkedAt: MATURED,
    });
    // Only client B recovered. If the post-action lookup leaked, A would be
    // credited with B's recovery.
    await db.insert(schema.serpRankings).values({
      clientId: clientB,
      keyword: "shared keyword",
      position: 1,
      previousPosition: 11,
      checkedAt: new Date(MATURED.getTime() + 86_400_000),
    });

    const [outcome] = await attributeOutcomes(clientA, { now: NOW });
    expect(outcome.positionAfter).toBeNull();
    expect(outcome.success).toBeNull();
  });

  it("throws rather than attributing without a client id", async () => {
    await expect(attributeOutcomes("", { now: NOW })).rejects.toThrow(/clientId is required/);
  });

  it("returns empty when there are no routings at all", async () => {
    expect(await attributeOutcomes(clientA, { now: NOW })).toEqual([]);
  });
});
