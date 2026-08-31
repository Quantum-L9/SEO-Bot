/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * INTEL-GATE-002 — the mode ladder and the runtime governors.
 *
 * The acceptance brief specifies a hard expected behaviour per mode. This file
 * is that specification executed: for each of the six modes it asserts the full
 * capability vector, so a change that quietly widens one rung fails here rather
 * than in production.
 *
 * The mode matrix is asserted exhaustively — every mode against every
 * capability — rather than spot-checked, because the failure that matters is a
 * capability becoming reachable one rung EARLIER than intended, and a spot
 * check of the intended rung would not see it.
 */

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  type ModeOptions,
  makeConfig,
  resetTables,
  schema,
  seedClient,
  silentLogger,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let pg: PGlite;
let configOptions: ModeOptions = {};

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
  assertClientId,
  type Capability,
  checkCapability,
  checkClientActive,
  checkLlmBudget,
  checkOutreachVelocity,
  checkRankingCircuitBreaker,
  evaluateGate,
  siteMutationReadiness,
} from "../../../src/modules/intelligence/policy-gate.js";

let clientA: string;
const NOW = new Date("2026-08-31T12:00:00Z");

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  pg = created.client;
});

beforeEach(async () => {
  configOptions = {};
  await resetTables(pg);
  clientA = await seedClient(db, { domain: "client-a.test" });
  delete process.env.SITE_DEPLOY_DRY_RUN;
});

/** Every flag on, so the matrix isolates the MODE as the only variable. */
const ALL_FLAGS_ON: ModeOptions = {
  INTELLIGENCE_LLM_PLANNING_ENABLED: true,
  INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING: true,
  INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true,
  INTELLIGENCE_ALLOW_SITE_MUTATION: true,
};

const CAPABILITIES: Capability[] = [
  "write_signals",
  "write_decisions",
  "route_safe_job",
  "llm_planning",
  "route_outreach",
  "route_site_mutation",
];

/**
 * The brief's mode table, transcribed. `true` means the mode permits the
 * capability when its flag is also set.
 */
const EXPECTED_MATRIX: Record<string, Record<Capability, boolean>> = {
  off: {
    write_signals: false,
    write_decisions: false,
    route_safe_job: false,
    llm_planning: false,
    route_outreach: false,
    route_site_mutation: false,
  },
  observe: {
    write_signals: true,
    write_decisions: false,
    route_safe_job: false,
    llm_planning: false,
    route_outreach: false,
    route_site_mutation: false,
  },
  recommend: {
    write_signals: true,
    write_decisions: true,
    route_safe_job: false,
    llm_planning: false,
    route_outreach: false,
    route_site_mutation: false,
  },
  route_safe: {
    write_signals: true,
    write_decisions: true,
    route_safe_job: true,
    llm_planning: false,
    route_outreach: false,
    route_site_mutation: false,
  },
  route_llm: {
    write_signals: true,
    write_decisions: true,
    route_safe_job: true,
    llm_planning: true,
    route_outreach: false,
    route_site_mutation: false,
  },
  full: {
    write_signals: true,
    write_decisions: true,
    route_safe_job: true,
    llm_planning: true,
    route_outreach: true,
    route_site_mutation: true,
  },
};

describe("the mode ladder", () => {
  for (const [mode, expected] of Object.entries(EXPECTED_MATRIX)) {
    for (const capability of CAPABILITIES) {
      it(`${mode}: ${capability} is ${expected[capability] ? "allowed" : "blocked"}`, () => {
        configOptions = { INTELLIGENCE_MODE: mode, ...ALL_FLAGS_ON };
        expect(checkCapability(capability).allowed).toBe(expected[capability]);
      });
    }
  }

  it("blocks everything at off even with every flag set", () => {
    configOptions = { INTELLIGENCE_MODE: "off", ...ALL_FLAGS_ON };
    for (const capability of CAPABILITIES) {
      const verdict = checkCapability(capability);
      expect(verdict.allowed).toBe(false);
      expect(verdict.gate).toBe("mode");
    }
  });
});

describe("mode and flag are independent", () => {
  it.each([
    ["route_safe_job", "route_safe", "INTELLIGENCE_ALLOW_SAFE_JOB_ROUTING"],
    ["llm_planning", "route_llm", "INTELLIGENCE_LLM_PLANNING_ENABLED"],
    ["route_outreach", "full", "INTELLIGENCE_ALLOW_OUTREACH_ROUTING"],
    ["route_site_mutation", "full", "INTELLIGENCE_ALLOW_SITE_MUTATION"],
  ])("%s needs its flag even at mode %s", (capability, mode, flag) => {
    // Mode high enough, flag off → still blocked, and the verdict names the
    // flag rather than the mode, so an operator can act on it.
    configOptions = { INTELLIGENCE_MODE: mode };
    const verdict = checkCapability(capability as Capability);
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("flag");
    expect(verdict.reason).toContain(flag);
  });

  it("a flag alone cannot raise a capability above its mode", () => {
    // The whole point of two conditions: setting the flag in observe mode must
    // not make outreach reachable.
    configOptions = { INTELLIGENCE_MODE: "observe", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true };
    const verdict = checkCapability("route_outreach");
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("mode");
  });
});

describe("assertClientId", () => {
  it.each([undefined, null, "", "   "])("throws for %j", (value) => {
    expect(() => assertClientId(value as string | null | undefined)).toThrow(
      /clientId is required/,
    );
  });

  it("accepts a real id", () => {
    expect(() => assertClientId("abc")).not.toThrow();
  });
});

describe("client activity", () => {
  it("blocks an inactive client", async () => {
    const inactive = await seedClient(db, { domain: "gone.test", active: false });
    const verdict = await checkClientActive(inactive);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("inactive");
  });

  it("blocks a client that does not exist", async () => {
    const verdict = await checkClientActive("00000000-0000-0000-0000-000000000000");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("not found");
  });

  it("allows an active client", async () => {
    expect((await checkClientActive(clientA)).allowed).toBe(true);
  });

  it("blocks even observation for an inactive client", async () => {
    // Deactivating a client is an operator saying stop. A loop that kept
    // extracting signals would be ignoring it.
    configOptions = { INTELLIGENCE_MODE: "observe" };
    const inactive = await seedClient(db, { domain: "gone2.test", active: false });
    const verdict = await evaluateGate({ capability: "write_signals", clientId: inactive });
    expect(verdict.allowed).toBe(false);
  });
});

describe("the LLM daily spend cap", () => {
  it("allows when no cap is configured", async () => {
    configOptions = {};
    expect((await checkLlmBudget()).allowed).toBe(true);
  });

  it("blocks once the day's recorded spend reaches the cap", async () => {
    configOptions = { DAILY_SPEND_CAP: 10 };
    await db.insert(schema.llmUsage).values({
      clientId: clientA,
      module: "intelligence",
      tier: "strategic",
      purpose: "planning",
      inputTokens: 100,
      outputTokens: 100,
      cost: 10.5,
      timestamp: new Date(),
    });
    const verdict = await checkLlmBudget();
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("llm_budget");
  });

  it("blocks LLM planning through the composite gate when the cap is spent", async () => {
    configOptions = {
      INTELLIGENCE_MODE: "route_llm",
      INTELLIGENCE_LLM_PLANNING_ENABLED: true,
      DAILY_SPEND_CAP: 1,
    };
    await db.insert(schema.llmUsage).values({
      clientId: clientA,
      module: "intelligence",
      tier: "strategic",
      purpose: "planning",
      inputTokens: 1,
      outputTokens: 1,
      cost: 5,
      timestamp: new Date(),
    });
    const verdict = await evaluateGate({ capability: "llm_planning", clientId: clientA });
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("llm_budget");
  });

  it("does not apply the LLM cap to non-LLM capabilities", async () => {
    // A spent LLM budget must not stop deterministic observation — the two
    // are unrelated costs.
    configOptions = { INTELLIGENCE_MODE: "observe", DAILY_SPEND_CAP: 1 };
    await db.insert(schema.llmUsage).values({
      clientId: clientA,
      module: "intelligence",
      tier: "strategic",
      purpose: "planning",
      inputTokens: 1,
      outputTokens: 1,
      cost: 99,
      timestamp: new Date(),
    });
    expect((await evaluateGate({ capability: "write_signals", clientId: clientA })).allowed).toBe(
      true,
    );
  });
});

describe("the ranking circuit breaker", () => {
  async function seedDrops(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await db.insert(schema.serpRankings).values({
        clientId: clientA,
        keyword: `kw-${index}`,
        previousPosition: 5,
        position: 40, // a 700% fall — well past the 30% threshold
        checkedAt: NOW,
      });
    }
  }

  it("stays closed for a stable client", async () => {
    await seedDrops(1);
    expect((await checkRankingCircuitBreaker(clientA)).allowed).toBe(true);
  });

  it("opens once more than two keywords have fallen significantly", async () => {
    await seedDrops(3);
    const verdict = await checkRankingCircuitBreaker(clientA);
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("circuit_breaker");
  });

  it("blocks outreach routing when open", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_OUTREACH_ROUTING: true };
    await seedDrops(3);
    const verdict = await evaluateGate({ capability: "route_outreach", clientId: clientA });
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("circuit_breaker");
  });

  it("ignores another client's drops", async () => {
    const clientB = await seedClient(db, { domain: "client-b.test" });
    for (let index = 0; index < 5; index += 1) {
      await db.insert(schema.serpRankings).values({
        clientId: clientB,
        keyword: `kw-${index}`,
        previousPosition: 5,
        position: 40,
        checkedAt: NOW,
      });
    }
    expect((await checkRankingCircuitBreaker(clientA)).allowed).toBe(true);
  });
});

describe("the link velocity governor", () => {
  async function seedQueued(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await db.insert(schema.linkProspects).values({
        clientId: clientA,
        targetUrl: `https://p${index}.test`,
        tactic: "guest_post",
        status: "outreach_queued",
        updatedAt: new Date(NOW.getTime() - 86_400_000),
      });
    }
  }

  it("allows while weekly headroom remains", async () => {
    await seedQueued(2);
    expect((await checkOutreachVelocity(clientA)).allowed).toBe(true);
  });

  it("blocks once the weekly cap is reached", async () => {
    // link-building's own SAFETY.maxLinksPerWeek is 5. The gate uses that same
    // constant, so the two can never disagree about the headroom.
    await seedQueued(5);
    const verdict = await checkOutreachVelocity(clientA);
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("velocity");
  });

  it("counts only the last seven days", async () => {
    for (let index = 0; index < 10; index += 1) {
      await db.insert(schema.linkProspects).values({
        clientId: clientA,
        targetUrl: `https://old${index}.test`,
        tactic: "guest_post",
        status: "outreach_queued",
        updatedAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    expect((await checkOutreachVelocity(clientA)).allowed).toBe(true);
  });
});

describe("site-deployment readiness vs liveness", () => {
  it("is not ready with no configuration at all", () => {
    expect(siteMutationReadiness(undefined)).toEqual({ ready: false, live: false });
    expect(siteMutationReadiness({})).toEqual({ ready: false, live: false });
  });

  it("is not ready with a half-populated config", () => {
    expect(
      siteMutationReadiness({ site_deployment: { githubToken: "t", websiteBotRepo: "" } }),
    ).toEqual({ ready: false, live: false });
    expect(
      siteMutationReadiness({ site_deployment: { githubToken: "", websiteBotRepo: "o/r" } }),
    ).toEqual({ ready: false, live: false });
  });

  it("is ready but NOT live under NODE_ENV=test", () => {
    // The full dry-run rehearsal depends on exactly this distinction: the work
    // routes, the transport writes nothing.
    expect(
      siteMutationReadiness({ site_deployment: { githubToken: "t", websiteBotRepo: "o/r" } }),
    ).toEqual({ ready: true, live: false });
  });

  it("is ready but NOT live when SITE_DEPLOY_DRY_RUN is set", () => {
    process.env.SITE_DEPLOY_DRY_RUN = "true";
    const readiness = siteMutationReadiness({
      site_deployment: { githubToken: "t", websiteBotRepo: "o/r" },
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.live).toBe(false);
  });

  it("blocks site mutation when the client is not ready", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_SITE_MUTATION: true };
    const verdict = await evaluateGate({
      capability: "route_site_mutation",
      clientId: clientA,
      clientConfig: {},
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("site_deployment");
  });

  it("allows site-mutation ROUTING for a ready client even while dry-run forces no live write", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_SITE_MUTATION: true };
    const verdict = await evaluateGate({
      capability: "route_site_mutation",
      clientId: clientA,
      clientConfig: { site_deployment: { githubToken: "t", websiteBotRepo: "o/r" } },
    });
    expect(verdict.allowed).toBe(true);
  });

  it("blocks site mutation entirely when the flag is off", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", INTELLIGENCE_ALLOW_SITE_MUTATION: false };
    const verdict = await evaluateGate({
      capability: "route_site_mutation",
      clientId: clientA,
      clientConfig: { site_deployment: { githubToken: "t", websiteBotRepo: "o/r" } },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("flag");
  });
});

describe("evaluateGate ordering", () => {
  it("reports the mode before touching the database", async () => {
    configOptions = { INTELLIGENCE_MODE: "off" };
    const verdict = await evaluateGate({
      capability: "route_outreach",
      clientId: "not-a-uuid-at-all",
    });
    // A cheap refusal that never queried — an invalid client id would have
    // thrown had the client lookup run first.
    expect(verdict.allowed).toBe(false);
    expect(verdict.gate).toBe("mode");
  });

  it("throws on a missing client id rather than returning a verdict", async () => {
    configOptions = { INTELLIGENCE_MODE: "full", ...ALL_FLAGS_ON };
    await expect(evaluateGate({ capability: "write_signals", clientId: "" })).rejects.toThrow(
      /clientId is required/,
    );
  });
});
