/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeDomain,
  classifyDomain,
  QUALIFICATION_MIN_DISTINCT_QUERIES,
  QUALIFICATION_STRONG_RANK,
  qualifyDomain,
  structuralExclusion,
} from "../../src/build-intelligence/domain-classification.js";

describe("canonicalizeDomain", () => {
  it("strips scheme, www, path, query, and lowercases", () => {
    expect(canonicalizeDomain("https://www.Example.com/foo?x=1")).toBe("example.com");
    expect(canonicalizeDomain("www.example.com.")).toBe("example.com");
    expect(canonicalizeDomain("EXAMPLE.com")).toBe("example.com");
    expect(canonicalizeDomain("example.com:443/path")).toBe("example.com");
  });
  it("is idempotent", () => {
    expect(canonicalizeDomain(canonicalizeDomain("https://www.example.com"))).toBe("example.com");
  });
  it("folds www and bare host to one identity", () => {
    expect(canonicalizeDomain("https://www.example.com")).toBe(canonicalizeDomain("example.com"));
  });
});

describe("classifyDomain — structural exclusions", () => {
  it("classifies known non-donor properties, subdomains included", () => {
    expect(classifyDomain("facebook.com")).toBe("social");
    expect(classifyDomain("m.facebook.com")).toBe("social");
    expect(classifyDomain("www.yelp.com")).toBe("directory");
    expect(classifyDomain("amazon.com")).toBe("marketplace");
    expect(classifyDomain("forbes.com")).toBe("publisher");
    expect(classifyDomain("trustpilot.com")).toBe("aggregator");
  });

  it("excludes non-commercial suffixes", () => {
    expect(classifyDomain("dallas.gov")).toBe("irrelevant");
    expect(classifyDomain("city.dallas.gov")).toBe("irrelevant");
    expect(classifyDomain("mit.edu")).toBe("irrelevant");
    expect(classifyDomain("army.mil")).toBe("irrelevant");
  });

  it("excludes tenants of hosted site-builder platforms", () => {
    expect(classifyDomain("someroofer.wixsite.com")).toBe("irrelevant");
    expect(classifyDomain("bobs-roofs.blogspot.com")).toBe("irrelevant");
    expect(classifyDomain("shop.myshopify.com")).toBe("irrelevant");
  });

  it("excludes unambiguous listing-site name markers", () => {
    expect(classifyDomain("roofingdirectory.com")).toBe("directory");
    expect(classifyDomain("top10roofers.com")).toBe("directory");
  });

  it("does NOT exclude a real operating company with a marketing-sounding name", () => {
    expect(classifyDomain("bestroofingdallas.com")).toBeNull();
    expect(classifyDomain("alpha-roofing.com")).toBeNull();
    expect(classifyDomain("some-local-business.io")).toBeNull();
  });

  it("reports the exact deterministic rule that fired", () => {
    expect(structuralExclusion("m.facebook.com")).toEqual({
      reason: "social",
      rule: "curated_list:social",
    });
    expect(structuralExclusion("dallas.gov")).toEqual({
      reason: "irrelevant",
      rule: "non_commercial_suffix:.gov",
    });
    expect(structuralExclusion("alpha-roofing.com")).toBeNull();
  });
});

describe("qualifyDomain — three-state donor qualification", () => {
  it("qualifies a domain corroborated across multiple queries", () => {
    const verdict = qualifyDomain("alpha-roofing.com", {
      distinctQueryCount: QUALIFICATION_MIN_DISTINCT_QUERIES,
      bestRank: 19,
    });
    expect(verdict.status).toBe("qualified");
  });

  it("qualifies a domain with a single strong placement", () => {
    const verdict = qualifyDomain("alpha-roofing.com", {
      distinctQueryCount: 1,
      bestRank: QUALIFICATION_STRONG_RANK,
    });
    expect(verdict.status).toBe("qualified");
  });

  it("returns UNKNOWN — never qualified — for an uncorroborated one-off result", () => {
    const verdict = qualifyDomain("mystery-domain.com", {
      distinctQueryCount: 1,
      bestRank: QUALIFICATION_STRONG_RANK + 1,
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict).toMatchObject({
      reason: "irrelevant",
      rule: "insufficient_market_corroboration",
    });
  });

  it("lets a structural exclusion win over strong ranking evidence", () => {
    const verdict = qualifyDomain("yelp.com", { distinctQueryCount: 9, bestRank: 1 });
    expect(verdict).toMatchObject({ status: "excluded", reason: "directory" });
  });

  it("does not reject an operating company merely for ranking informational content", () => {
    const verdict = qualifyDomain("alpha-roofing.com/blog/how-to-clean-gutters", {
      distinctQueryCount: 3,
      bestRank: 4,
    });
    expect(verdict.status).toBe("qualified");
  });
});
