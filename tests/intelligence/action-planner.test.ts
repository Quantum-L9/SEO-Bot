/* L9_META
 * layer: test
 * role: intelligence_unit_test
 * status: active
 */

/**
 * The planner is where the plane's promise — "it proposes, it never mutates" —
 * either holds or quietly stops holding. Two invariants carry it:
 *
 *   - every template action is inside the evidence-pack allow-list for its
 *     opportunity type (so nothing can propose a CRITICAL structural change);
 *   - every follow-up job is inside the scheduler's TRIGGERABLE_JOBS (which
 *     excludes `serp:execute-surpass-plans`, the gated live-site write path).
 *
 * The module asserts both at import; these tests pin them so a future template
 * edit that violates one fails here with a readable reason rather than as an
 * opaque import-time crash in production.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/database/index.js", () => ({
  getDb: () => ({}),
  schema: { actionLog: {} },
}));
vi.mock("../../src/core/logger.js", () => ({
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { TRIGGERABLE_JOBS } from "../../src/core/scheduler.js";
import {
  impactBand,
  PLAN_TEMPLATES,
  planOpportunity,
  planTemplateFor,
} from "../../src/intelligence/action-planner.js";
import { allowedActionsFor, FORBIDDEN_ACTIONS } from "../../src/intelligence/evidence-pack.js";
import type { PolicyState } from "../../src/intelligence/policy-engine.js";
import type { OpportunityType, ScoredOpportunity } from "../../src/intelligence/types.js";

const CLIENT = "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04";

function state(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    autonomousActionsPaused: false,
    pauseReason: null,
    dailyLlmBudgetRemaining: 10,
    outreachCapacityRemaining: 5,
    rankingCircuitOpen: false,
    ...overrides,
  };
}

function opportunity(
  opportunityType: OpportunityType,
  overrides: Partial<ScoredOpportunity> = {},
): ScoredOpportunity {
  return {
    clientId: CLIENT,
    opportunityType,
    title: "t",
    description: "d",
    targetUrl: "/pricing",
    targetKeyword: "roofing austin",
    expectedImpact: 9,
    effort: 4,
    risk: 2,
    urgency: 0.75,
    confidence: 0.85,
    score: 80,
    fingerprint: "fp-1",
    signals: [],
    evidence: {},
    ...overrides,
  };
}

function inputs(overrides: Partial<Parameters<typeof planOpportunity>[1]> = {}) {
  return {
    policyState: state(),
    clientActive: true,
    minScore: 20,
    maxActionsPerRun: 3,
    actionsTakenThisRun: 0,
    openFingerprints: new Set<string>(),
    ...overrides,
  };
}

describe("plan template invariants", () => {
  it("only names actions inside the allow-list for their opportunity type", () => {
    for (const [opportunityType, template] of Object.entries(PLAN_TEMPLATES)) {
      if (!template) continue;
      expect(allowedActionsFor(opportunityType), opportunityType).toContain(template.action);
    }
  });

  it("never names a forbidden action", () => {
    for (const template of Object.values(PLAN_TEMPLATES)) {
      if (!template) continue;
      expect(FORBIDDEN_ACTIONS).not.toContain(template.action);
    }
  });

  it("only queues jobs on the scheduler's trigger allow-list", () => {
    for (const template of Object.values(PLAN_TEMPLATES)) {
      if (!template?.followUpJob) continue;
      expect(TRIGGERABLE_JOBS).toContain(template.followUpJob);
    }
  });

  it("cannot reach the gated live-site write job", () => {
    // serp:execute-surpass-plans writes the client's live site (AGENTS §9).
    expect(TRIGGERABLE_JOBS).not.toContain("serp:execute-surpass-plans");
    for (const template of Object.values(PLAN_TEMPLATES)) {
      expect(template?.followUpJob).not.toBe("serp:execute-surpass-plans");
    }
  });

  it("has no template for the diagnostic-only opportunity types", () => {
    expect(planTemplateFor("budget_review")).toBeNull();
    expect(planTemplateFor("pipeline_repair")).toBeNull();
  });

  it("marks outreach as outreach so the velocity governor applies to it", () => {
    expect(PLAN_TEMPLATES.link_outreach_batch?.isOutreach).toBe(true);
    // And nothing else claims to be outreach.
    for (const [type, template] of Object.entries(PLAN_TEMPLATES)) {
      if (type === "link_outreach_batch") continue;
      expect(template?.isOutreach, type).toBe(false);
    }
  });
});

describe("planOpportunity", () => {
  it("produces a proposal and an execution decision when policy allows", () => {
    const planned = planOpportunity(opportunity("keyword_recovery"), inputs());

    expect(planned.verdict.decision).toBe("propose_action");
    expect(planned.proposal?.action).toBe("meta_title_update");
    expect(planned.execution).not.toBeNull();
  });

  it("routes the proposal through the EXISTING execution policy classification", () => {
    // The planner supplies an action name; the execution policy — not the
    // planner — decides its risk level and reversibility.
    const planned = planOpportunity(opportunity("keyword_recovery"), inputs());
    expect(planned.proposal?.riskLevel).toBe("low");
    expect(planned.proposal?.reversible).toBe(true);
    expect(planned.execution?.execute).toBe(true);
  });

  it("classifies outreach as medium/irreversible, as the taxonomy defines it", () => {
    const planned = planOpportunity(opportunity("link_outreach_batch"), inputs());
    expect(planned.proposal?.action).toBe("outreach_email_send");
    expect(planned.proposal?.riskLevel).toBe("medium");
    expect(planned.proposal?.reversible).toBe(false);
  });

  it("attributes the proposal to the opportunity that produced it", () => {
    const planned = planOpportunity(opportunity("keyword_recovery"), inputs());
    expect(planned.proposal?.triggeredBy).toBe("intelligence:keyword_recovery:fp-1");
    expect(planned.proposal?.metadata).toMatchObject({
      opportunity_type: "keyword_recovery",
      opportunity_fingerprint: "fp-1",
      opportunity_score: 80,
    });
  });

  it("builds no proposal when policy refuses", () => {
    const planned = planOpportunity(
      opportunity("keyword_recovery"),
      inputs({ policyState: state({ autonomousActionsPaused: true, pauseReason: "paused" }) }),
    );
    expect(planned.verdict.decision).toBe("escalate_to_operator");
    expect(planned.proposal).toBeNull();
    expect(planned.execution).toBeNull();
  });

  it("builds no proposal for a diagnostic-only opportunity, even at a high score", () => {
    const planned = planOpportunity(opportunity("pipeline_repair", { score: 99 }), inputs());
    expect(planned.verdict.decision).toBe("run_diagnostic");
    expect(planned.proposal).toBeNull();
  });

  it("applies the outreach governor to the outreach template only", () => {
    const blocked = planOpportunity(
      opportunity("link_outreach_batch"),
      inputs({ policyState: state({ outreachCapacityRemaining: 0 }) }),
    );
    expect(blocked.verdict.decision).toBe("defer_budget");

    const unaffected = planOpportunity(
      opportunity("page_experience_repair"),
      inputs({ policyState: state({ outreachCapacityRemaining: 0 }) }),
    );
    expect(unaffected.verdict.decision).toBe("propose_action");
  });

  it("defers an LLM-spending template on an unknown budget but not a zero-token one", () => {
    const spending = planOpportunity(
      opportunity("keyword_recovery"),
      inputs({ policyState: state({ dailyLlmBudgetRemaining: null }) }),
    );
    expect(spending.verdict.decision).toBe("defer_budget");

    const free = planOpportunity(
      opportunity("page_experience_repair"),
      inputs({ policyState: state({ dailyLlmBudgetRemaining: null }) }),
    );
    expect(free.verdict.decision).toBe("propose_action");
  });

  it("suppresses an opportunity already open under the same fingerprint", () => {
    const planned = planOpportunity(
      opportunity("keyword_recovery"),
      inputs({ openFingerprints: new Set(["fp-1"]) }),
    );
    expect(planned.verdict.decision).toBe("suppress_duplicate");
    expect(planned.proposal).toBeNull();
  });
});

describe("impactBand", () => {
  it("labels the score band the operator dashboard shows", () => {
    expect(impactBand(80)).toBe("high");
    expect(impactBand(60)).toBe("high");
    expect(impactBand(59.9)).toBe("medium");
    expect(impactBand(30)).toBe("medium");
    expect(impactBand(29.9)).toBe("low");
    expect(impactBand(0)).toBe("low");
  });
});
