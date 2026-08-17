/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeDomain,
  classifyDomain,
  qualifyDomain,
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
});

describe("classifyDomain", () => {
  it("classifies known non-donor properties, subdomains included", () => {
    expect(classifyDomain("facebook.com")).toBe("social");
    expect(classifyDomain("m.facebook.com")).toBe("social");
    expect(classifyDomain("www.yelp.com")).toBe("directory");
    expect(classifyDomain("amazon.com")).toBe("marketplace");
    expect(classifyDomain("forbes.com")).toBe("publisher");
    expect(classifyDomain("trustpilot.com")).toBe("aggregator");
  });
  it("RETAINS ambiguous operating-company domains (returns null, never invents certainty)", () => {
    expect(classifyDomain("alpha-roofing.com")).toBeNull();
    expect(classifyDomain("some-local-business.io")).toBeNull();
  });
});

describe("qualifyDomain", () => {
  it("qualifies a real operating company", () => {
    expect(qualifyDomain("alpha-roofing.com")).toEqual({ status: "qualified" });
  });
  it("excludes directory/social/marketplace/publisher/aggregator", () => {
    expect(qualifyDomain("yelp.com")).toEqual({ status: "excluded", reason: "directory" });
    expect(qualifyDomain("facebook.com")).toEqual({ status: "excluded", reason: "social" });
    expect(qualifyDomain("amazon.com")).toEqual({ status: "excluded", reason: "marketplace" });
    expect(qualifyDomain("forbes.com")).toEqual({ status: "excluded", reason: "publisher" });
    expect(qualifyDomain("trustpilot.com")).toEqual({ status: "excluded", reason: "aggregator" });
  });
  it("marks platform hosts as UNKNOWN and does not treat them as qualified", () => {
    expect(qualifyDomain("some-roofer.blogspot.com")).toEqual({
      status: "unknown",
      reason: "irrelevant",
    });
    expect(qualifyDomain("example.wixsite.com")).toEqual({
      status: "unknown",
      reason: "irrelevant",
    });
  });
  it("marks empty/unparseable and IP literals as UNKNOWN", () => {
    expect(qualifyDomain("")).toEqual({ status: "unknown", reason: "irrelevant" });
    expect(qualifyDomain("10.0.0.1")).toEqual({ status: "unknown", reason: "irrelevant" });
  });
});
