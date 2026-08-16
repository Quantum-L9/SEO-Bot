/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, expect, it } from "vitest";
import {
  canonicalizeDomain,
  classifyDomain,
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
  it("RETAINS ambiguous/unknown domains (returns null, never invents certainty)", () => {
    expect(classifyDomain("alpha-roofing.com")).toBeNull();
    expect(classifyDomain("some-local-business.io")).toBeNull();
  });
});
