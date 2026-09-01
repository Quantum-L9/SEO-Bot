/* L9_META
 * layer: test
 * role: reporting_unit_test
 * status: active
 */

/**
 * The compiler is the injection boundary and the audience boundary of the
 * reporting plane. Two properties have to hold or the plane is worse than no
 * plane:
 *
 *   1. No caller-supplied text ever becomes SQL. Values bind as $n; identifiers
 *      come only from the registry.
 *   2. The `agent` audience cannot reach a column that deanonymizes a client.
 *
 * These are asserted against the SHIPPING registry rather than a fixture, so a
 * future edit that adds `domain` to an agent projection fails here.
 */

import { describe, expect, it } from "vitest";
import { compileReportingQuery, ReportingQueryError } from "../../src/reporting/query-compiler.js";
import {
  AGENT_FORBIDDEN_COLUMNS,
  assertRegistryIdentifiersAreSafe,
  BENCHMARK_K_ANONYMITY_FLOOR,
  getReportingView,
  listReportingViews,
  REPORTING_VIEWS,
  type ReportingViewDefinition,
} from "../../src/reporting/views.js";

describe("reporting registry", () => {
  it("passes its own identifier safety assertions", () => {
    expect(() => assertRegistryIdentifiersAreSafe()).not.toThrow();
  });

  it("rejects a view whose ORDER BY fragment smuggles in an expression", () => {
    const hostile = [
      {
        ...REPORTING_VIEWS[0],
        orderBy: { evil: "created_at DESC; DROP TABLE clients" },
        defaultOrderBy: "evil",
      },
    ] as unknown as ReportingViewDefinition[];
    expect(() => assertRegistryIdentifiersAreSafe(hostile)).toThrow(/unsafe ORDER BY/);
  });

  it("rejects a view whose relation is not a plain quoted schema.table", () => {
    const hostile = [
      { ...REPORTING_VIEWS[0], relation: '"reporting"."x" UNION SELECT 1' },
    ] as unknown as ReportingViewDefinition[];
    expect(() => assertRegistryIdentifiersAreSafe(hostile)).toThrow(/unsafe relation/);
  });

  it("rejects an agent projection that leaks client identity", () => {
    const hostile = [
      {
        ...REPORTING_VIEWS[0],
        projections: { operator: ["client_id", "domain"], agent: ["domain"] },
      },
    ] as unknown as ReportingViewDefinition[];
    expect(() => assertRegistryIdentifiersAreSafe(hostile)).toThrow(/identity\/PII column/);
  });

  it("rejects an agent projection that is not a subset of the operator projection", () => {
    const hostile = [
      {
        ...REPORTING_VIEWS[0],
        projections: { operator: ["client_id"], agent: ["industry"] },
      },
    ] as unknown as ReportingViewDefinition[];
    expect(() => assertRegistryIdentifiersAreSafe(hostile)).toThrow(/not in the operator/);
  });

  it("never exposes an identity or PII column to the agent audience", () => {
    for (const view of listReportingViews("agent")) {
      for (const column of view.projections.agent ?? []) {
        expect(AGENT_FORBIDDEN_COLUMNS.has(column)).toBe(false);
      }
    }
  });

  it("keeps contact PII off the agent surface entirely", () => {
    const agentViews = listReportingViews("agent").map((view) => view.name);
    expect(agentViews).not.toContain("link_prospects_uncontacted");
    expect(agentViews).not.toContain("clients_safe");
  });
});

describe("compileReportingQuery — identifiers and binding", () => {
  it("binds every caller value as a parameter and emits no literal from input", () => {
    const compiled = compileReportingQuery(
      {
        view: "keyword_drops_7d",
        filters: { client_id: "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04", min_delta: 12 },
        limit: 25,
      },
      "operator",
    );

    expect(compiled.params).toEqual(["3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04", 12, 25]);
    expect(compiled.text).toContain("$1::uuid");
    expect(compiled.text).toContain("$2::int");
    expect(compiled.text).toContain("LIMIT $3");
    // The values themselves never appear as literals in the statement.
    expect(compiled.text).not.toContain("3f1b0c4e");
    expect(compiled.text).not.toContain("12");
  });

  it("produces identical SQL regardless of the caller's filter key order", () => {
    const a = compileReportingQuery(
      {
        view: "keyword_drops_7d",
        filters: { min_delta: 7, client_id: "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04" },
      },
      "operator",
    );
    const b = compileReportingQuery(
      {
        view: "keyword_drops_7d",
        filters: { client_id: "3f1b0c4e-8a2d-4f6b-9c1e-2a7d5b3e9f04", min_delta: 7 },
      },
      "operator",
    );
    expect(a.text).toBe(b.text);
    expect(a.sqlHash).toBe(b.sqlHash);
    expect(a.params).toEqual(b.params);
  });

  it("hashes the statement shape, not its parameter values", () => {
    const first = compileReportingQuery(
      { view: "keyword_drops_7d", filters: { min_delta: 5 } },
      "operator",
    );
    const second = compileReportingQuery(
      { view: "keyword_drops_7d", filters: { min_delta: 50 } },
      "operator",
    );
    expect(first.sqlHash).toBe(second.sqlHash);
    expect(first.params).not.toEqual(second.params);
  });

  it("selects the audience projection rather than *", () => {
    const compiled = compileReportingQuery({ view: "llm_spend_monthly" }, "agent");
    expect(compiled.text.startsWith("SELECT ")).toBe(true);
    expect(compiled.text).not.toContain("*");
    expect(compiled.columns).not.toContain("client_name");
    expect(compiled.columns).not.toContain("domain");
  });

  it("gives the operator audience the wider projection on the same view", () => {
    const operator = compileReportingQuery({ view: "llm_spend_monthly" }, "operator");
    const agent = compileReportingQuery({ view: "llm_spend_monthly" }, "agent");
    expect(operator.columns).toContain("client_name");
    expect(agent.columns.length).toBeLessThan(operator.columns.length);
  });
});

describe("compileReportingQuery — rejections", () => {
  it("rejects an unknown view", () => {
    expect(() => compileReportingQuery({ view: "clients" }, "operator")).toThrow(
      ReportingQueryError,
    );
  });

  it("rejects an operator-only view for the agent audience", () => {
    expect(() => compileReportingQuery({ view: "link_prospects_uncontacted" }, "agent")).toThrow(
      /not available to the agent audience/,
    );
  });

  it("rejects an unknown filter instead of silently ignoring it", () => {
    // Silently dropping an unrecognized filter is the dangerous behavior: the
    // caller believes it scoped the query to one tenant and gets the portfolio.
    expect(() =>
      compileReportingQuery({ view: "keyword_drops_7d", filters: { tenant: "acme" } }, "operator"),
    ).toThrow(/Unknown filter/);
  });

  it("rejects a non-UUID client id", () => {
    expect(() =>
      compileReportingQuery(
        { view: "keyword_drops_7d", filters: { client_id: "1' OR '1'='1" } },
        "operator",
      ),
    ).toThrow(/must be a UUID/);
  });

  it("rejects an enum value outside the declared set", () => {
    expect(() =>
      compileReportingQuery(
        { view: "keyword_drops_7d", filters: { device: "desktop; DROP TABLE clients" } },
        "operator",
      ),
    ).toThrow(/must be one of/);
  });

  it("rejects an integer outside the declared range", () => {
    expect(() =>
      compileReportingQuery(
        { view: "link_prospects_uncontacted", filters: { min_domain_rating: 5000 } },
        "operator",
      ),
    ).toThrow(/must be between 0 and 100/);
  });

  it("rejects a non-integer where an integer is declared", () => {
    expect(() =>
      compileReportingQuery({ view: "keyword_drops_7d", filters: { min_delta: 7.5 } }, "operator"),
    ).toThrow(/must be an integer/);
  });

  it("rejects an unknown orderBy alias", () => {
    expect(() =>
      compileReportingQuery({ view: "keyword_drops_7d", orderBy: "position; --" }, "operator"),
    ).toThrow(/Unknown orderBy/);
  });

  it("rejects a limit above the view's maximum", () => {
    const view = getReportingView("keyword_drops_7d");
    expect(view).toBeDefined();
    expect(() =>
      compileReportingQuery(
        { view: "keyword_drops_7d", limit: (view?.maxLimit ?? 0) + 1 },
        "operator",
      ),
    ).toThrow(/must be between 1 and/);
  });

  it("rejects more enum values than the filter permits", () => {
    expect(() =>
      compileReportingQuery(
        {
          view: "page_experience_risks",
          filters: { risk_level: ["critical", "high", "medium", "low", "critical", "high"] },
        },
        "operator",
      ),
    ).toThrow(/at most 4 value/);
  });
});

describe("compileReportingQuery — defaults", () => {
  it("applies the view's default order and limit when none is given", () => {
    const view = getReportingView("pending_approvals");
    expect(view).toBeDefined();
    const compiled = compileReportingQuery({ view: "pending_approvals" }, "operator");
    expect(compiled.orderBy).toBe(view?.defaultOrderBy);
    expect(compiled.limit).toBe(view?.defaultLimit);
    expect(compiled.params).toEqual([view?.defaultLimit]);
  });

  it("omits WHERE entirely when no filter is supplied", () => {
    const compiled = compileReportingQuery({ view: "pending_approvals" }, "operator");
    expect(compiled.text).not.toContain("WHERE");
  });

  it("treats null and undefined filter values as absent, not as SQL NULL", () => {
    const compiled = compileReportingQuery(
      { view: "keyword_drops_7d", filters: { client_id: null, min_delta: undefined } },
      "operator",
    );
    expect(compiled.text).not.toContain("WHERE");
    expect(compiled.appliedFilters).toEqual({});
  });

  it("records applied filters for the audit row", () => {
    const compiled = compileReportingQuery(
      {
        view: "page_experience_risks",
        filters: { risk_level: ["critical", "high"], min_pageviews: 100 },
      },
      "agent",
    );
    expect(compiled.appliedFilters).toEqual({
      risk_level: ["critical", "high"],
      min_pageviews: 100,
    });
  });

  it("compiles every registry view for every audience it declares", () => {
    for (const view of REPORTING_VIEWS) {
      for (const audience of ["operator", "agent"] as const) {
        if (!view.projections[audience]) continue;
        const compiled = compileReportingQuery({ view: view.name }, audience);
        expect(compiled.text).toContain(view.relation);
        expect(compiled.params).toHaveLength(1);
      }
    }
  });

  // ─── The `token` filter kind (contract C1) ─────────────────────────────────
  //
  // Industry and state are open sets — whatever client registration recorded —
  // so an enum cannot enumerate them. The value is a bound parameter either way,
  // so these assertions are not about injection; they are about a caller string
  // never reaching the audit row unbounded, and a malformed dimension being a
  // rejection rather than an empty result that reads like "no such cohort".

  it("binds a token filter as a parameter and never as SQL text", () => {
    const compiled = compileReportingQuery(
      { view: "portfolio_benchmarks", filters: { industry: "legal" } },
      "agent",
    );
    expect(compiled.text).toContain("industry = $1");
    expect(compiled.text).not.toContain("legal");
    expect(compiled.params[0]).toBe("legal");
  });

  it("lower-cases and trims a token to match the view's normalized dimensions", () => {
    // The view COALESCEs and lower-cases its cohort dimensions so "Legal" and
    // "legal" are one cohort; a filter that did not would silently miss it.
    const compiled = compileReportingQuery(
      { view: "portfolio_benchmarks", filters: { industry: "  Legal  " } },
      "agent",
    );
    expect(compiled.params[0]).toBe("legal");
    expect(compiled.appliedFilters.industry).toBe("legal");
  });

  it("rejects an empty, oversized, or hostile token", () => {
    for (const hostile of [
      "",
      "   ",
      "legal'; DROP TABLE clients--",
      "legal OR 1=1",
      "x".repeat(81),
      42,
      ["legal"],
    ]) {
      expect(
        () =>
          compileReportingQuery(
            { view: "portfolio_benchmarks", filters: { industry: hostile } },
            "agent",
          ),
        String(hostile),
      ).toThrow(ReportingQueryError);
    }
  });

  it("treats a null token as an omitted filter, not a rejection", () => {
    // Established compiler behavior for every filter kind: null/undefined means
    // "no filter", so a caller may pass an absent dimension without branching.
    const compiled = compileReportingQuery(
      { view: "portfolio_benchmarks", filters: { industry: null } },
      "agent",
    );
    expect(compiled.text).not.toContain("WHERE");
    expect(compiled.appliedFilters).toEqual({});
  });

  it("refuses to ask for a cohort below the anonymity floor", () => {
    // Below the floor there is nothing to return, and an empty result reads
    // like "no such cohort" rather than "suppressed" — so it is a rejection.
    expect(() =>
      compileReportingQuery(
        { view: "portfolio_benchmarks", filters: { min_cohort_size: 2 } },
        "agent",
      ),
    ).toThrow(ReportingQueryError);

    expect(() =>
      compileReportingQuery(
        { view: "portfolio_benchmarks", filters: { min_cohort_size: BENCHMARK_K_ANONYMITY_FLOOR } },
        "agent",
      ),
    ).not.toThrow();
  });

  it("gives the agent audience the full benchmark projection and no identity", () => {
    const compiled = compileReportingQuery({ view: "portfolio_benchmarks" }, "agent");
    expect(compiled.columns).toContain("citation_rate_p50");
    for (const forbidden of ["client_id", "client_name", "domain"]) {
      expect(compiled.columns).not.toContain(forbidden);
      expect(compiled.text).not.toContain(forbidden);
    }
  });
});
