/* L9_META
 * layer: test
 * role: module_unit_test
 * status: active
 */

/**
 * The named queries carry the module's tenant-isolation guarantee, so these
 * tests inspect the SQL each one BUILDS rather than mocking a query builder.
 *
 * That distinction is the point. A test that stubs Drizzle and checks the
 * returned rows passes even against a statement with no WHERE clause at all —
 * the stub decides what comes back. Reading the generated SQL and its bound
 * parameters checks the thing that actually reaches Postgres.
 *
 * Two properties are pinned for every extractor:
 *  - the client id is a BOUND PARAMETER, never interpolated into the text, so a
 *    client id cannot alter the statement;
 *  - the statement carries the ON CONFLICT upsert, which is what makes a
 *    BullMQ retry idempotent rather than duplicative.
 */

import { describe, expect, it } from "vitest";
import {
  assertClientId,
  budgetPressureQuery,
  citationLossQuery,
  failedJobsQuery,
  inferTargetUrlQuery,
  keywordDropsQuery,
  PROSPECT_READY_STATUS,
  pageExperienceRisksQuery,
  prospectReadinessQuery,
  THRESHOLDS,
} from "../../../src/modules/intelligence/queries/index.js";

const CLIENT_A = "11111111-1111-1111-1111-111111111111";
const RUN = "99999999-9999-9999-9999-999999999999";

/**
 * Render a Drizzle SQL object to its statement text plus its bound parameters.
 *
 * Walks the chunk tree rather than calling a dialect's `toQuery`, so the test
 * has no opinion about placeholder syntax — only about which values reached the
 * text and which reached the parameter list. That is exactly the distinction
 * the tenant-scoping assertions depend on.
 */
function render(statement: unknown): { text: string; params: unknown[] } {
  const text: string[] = [];
  const params: unknown[] = [];

  const walk = (chunk: unknown): void => {
    if (chunk === null || chunk === undefined) return;

    // A primitive embedded directly in the template is a bound value.
    if (typeof chunk !== "object") {
      params.push(chunk);
      text.push(" $param ");
      return;
    }

    if (Array.isArray(chunk)) {
      for (const item of chunk) walk(item);
      return;
    }

    const node = chunk as Record<string, unknown>;

    // Nested SQL fragment.
    if (Array.isArray(node.queryChunks)) {
      for (const item of node.queryChunks as unknown[]) walk(item);
      return;
    }

    // StringChunk: literal statement text.
    if (Array.isArray(node.value)) {
      text.push((node.value as unknown[]).join(""));
      return;
    }

    // Param: a bound value, which must never appear in the text.
    if ("value" in node) {
      params.push(node.value);
      text.push(" $param ");
      return;
    }

    // Column/table references contribute an identifier, not a value.
    if (typeof node.name === "string") {
      text.push(node.name);
    }
  };

  walk(statement);
  return { text: text.join(""), params };
}

const EXTRACTORS = [
  { name: "keyword_drop", build: () => keywordDropsQuery(CLIENT_A, RUN) },
  { name: "bad_lcp_high_exit", build: () => pageExperienceRisksQuery(CLIENT_A, RUN) },
  { name: "citation_loss", build: () => citationLossQuery(CLIENT_A, RUN) },
  { name: "prospect_ready", build: () => prospectReadinessQuery(CLIENT_A, RUN) },
  { name: "job_failure_cluster", build: () => failedJobsQuery(CLIENT_A, RUN) },
  { name: "llm_budget_pressure", build: () => budgetPressureQuery(CLIENT_A, RUN, 5) },
] as const;

describe("clientId is mandatory on every query", () => {
  it.each([undefined, null, "", "   "])("throws for %p", (value) => {
    expect(() => keywordDropsQuery(value as never, RUN)).toThrow(/clientId is required/);
    expect(() => prospectReadinessQuery(value as never, RUN)).toThrow(/clientId is required/);
    expect(() => inferTargetUrlQuery(value as never, null)).toThrow(/clientId is required/);
  });

  it("assertClientId accepts a real id", () => {
    expect(() => assertClientId(CLIENT_A)).not.toThrow();
  });
});

describe("tenant scoping", () => {
  it.each(EXTRACTORS)("$name binds the client id rather than interpolating it", ({ build }) => {
    const { text, params } = render(build());
    // The id must arrive as a bound parameter...
    expect(params).toContain(CLIENT_A);
    // ...and must NOT appear anywhere in the statement text.
    expect(text).not.toContain(CLIENT_A);
  });

  it.each(EXTRACTORS)("$name filters on client_id", ({ build }) => {
    const { text } = render(build());
    expect(text).toMatch(/client_id\s*=/);
  });
});

describe("idempotency", () => {
  it.each(EXTRACTORS)("$name upserts on the signal fingerprint", ({ build }) => {
    const { text } = render(build());
    expect(text).toContain("ON CONFLICT (client_id, fingerprint) DO UPDATE");
  });

  it.each(EXTRACTORS)(
    "$name never resets status or first_seen_at on re-observation",
    ({ build }) => {
      const { text } = render(build());
      const updateClause = text.slice(text.indexOf("DO UPDATE"));
      // A suppressed signal must not be reopened, and first_seen_at records when
      // the problem started — a re-observation must not reset either.
      expect(updateClause).not.toMatch(/\bstatus\s*=/);
      expect(updateClause).not.toMatch(/first_seen_at\s*=/);
    },
  );
});

describe("query semantics", () => {
  it("keyword_drop requires both positions to be non-null", () => {
    // A null position means "outside the tracked range", not "position 0" —
    // subtracting it would manufacture a hundred-place move.
    const { text } = render(keywordDropsQuery(CLIENT_A, RUN));
    expect(text).toContain("sr.position IS NOT NULL");
    expect(text).toContain("sr.previous_position IS NOT NULL");
  });

  it("keyword_drop keys severity on crossing off page one, not final position", () => {
    const { text } = render(keywordDropsQuery(CLIENT_A, RUN));
    expect(text).toContain("sr.previous_position <= 10 AND sr.position > 10");
  });

  it("keyword_drop collapses history to the newest row per keyword", () => {
    // Without this the same keyword's rows collide on one fingerprint and the
    // upsert applies them in arbitrary order.
    const { text } = render(keywordDropsQuery(CLIENT_A, RUN));
    expect(text).toContain("MAX(checked_at)");
  });

  it("page_experience normalizes URL to path so the join can match", () => {
    // web_vitals stores a full URL, page_engagement stores a path. Without
    // normalization this join matches nothing and the signal never fires.
    const { text } = render(pageExperienceRisksQuery(CLIENT_A, RUN));
    expect(text).toContain("regexp_replace");
    expect(text).toContain("^https?://[^/]+");
  });

  it("citation_loss requires a PRIOR citation to have been lost", () => {
    // "never cited here" and "was cited and lost it" are different facts.
    const { text } = render(citationLossQuery(CLIENT_A, RUN));
    expect(text).toContain("prior.cited = true");
    expect(text).toContain("latest.cited = false");
  });

  it("prospect_ready filters on the status link-building actually writes", () => {
    // REGRESSION: filtering on "discovered" (the column default) matched
    // nothing, because discoverProspects always overwrites it on insert.
    expect(PROSPECT_READY_STATUS).toBe("ready");
    const { params } = render(prospectReadinessQuery(CLIENT_A, RUN));
    expect(params).toContain("ready");
  });

  it("prospect_ready never places the contact email in evidence", () => {
    // Evidence reaches the LLM planner and the operator API; a prospect's email
    // is PII with no bearing on whether to act.
    const { text } = render(prospectReadinessQuery(CLIENT_A, RUN));
    expect(text).toContain("contact_email IS NOT NULL");
    expect(text).not.toContain("'contact_email', lp.contact_email");
  });

  it("job_failure_cluster requires a cluster, not a single failure", () => {
    const { text, params } = render(failedJobsQuery(CLIENT_A, RUN));
    expect(text).toContain("HAVING COUNT(*) >=");
    expect(params).toContain(THRESHOLDS.jobFailureClusterCount);
  });

  it("budget_pressure reads llm_usage, not the action_outcomes estimate", () => {
    // LlmService writes llm_usage; /api/token-budget derives a different number
    // from action_outcomes. The recorded spend is the one that matters here.
    const { text } = render(budgetPressureQuery(CLIENT_A, RUN, 5));
    expect(text).toContain("FROM llm_usage");
    expect(text).not.toContain("action_outcomes");
  });

  it("target-URL inference prefers observed rankings over weaker sources", () => {
    const { text } = render(inferTargetUrlQuery(CLIENT_A, "metal roofing"));
    expect(text).toContain("serp_rankings");
    expect(text).toContain("gap_analyses");
    expect(text).toContain("faq_optimizations");
    expect(text).toContain("page_engagement");
    expect(text).toContain("ORDER BY rank ASC");
  });
});
