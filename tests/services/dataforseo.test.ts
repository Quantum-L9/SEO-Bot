/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { post } }));
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "pass" }),
}));

import {
  DataForSeoClient,
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  normalizeSerpDatetime,
  SerpEvidenceInvalidError,
  wrapDataForSeoTransportError,
} from "../../src/services/dataforseo.js";

beforeEach(() => post.mockReset());

describe("DataForSeoClient.getOrganicSerp", () => {
  it("returns organic-only items with canonical domains and provider datetime", async () => {
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [
          {
            time: "0.3 sec",
            status_code: 20000,
            result: [
              {
                datetime: "2024-01-02 12:00:00 +00:00",
                item_types: ["organic", "paid", "people_also_ask"],
                items: [
                  { type: "paid", rank_absolute: 1, url: "https://ad.example.com" },
                  {
                    type: "organic",
                    rank_group: 1,
                    rank_absolute: 2,
                    url: "https://www.Alpha.com/x",
                    title: "A",
                    description: "da",
                  },
                  { type: "people_also_ask", rank_absolute: 3 },
                  {
                    type: "organic",
                    rank_group: 2,
                    rank_absolute: 5,
                    url: "https://beta.com/",
                    title: "B",
                    description: "db",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const client = new DataForSeoClient();
    const result = await client.getOrganicSerp({ keyword: "metal roofing" });

    expect(result.items).toHaveLength(2); // paid + PAA excluded
    expect(result.items[0]).toMatchObject({
      rankGroup: 1,
      domain: "alpha.com",
      url: "https://www.Alpha.com/x",
    });
    expect(result.items[1]).toMatchObject({ rankGroup: 2, domain: "beta.com" });
    expect(result.observedAt).toBe("2024-01-02T12:00:00.000Z");
    expect(result.serpFeatures).toContain("paid");
  });

  it("surfaces DataForSEO API errors as DATAFORSEO_UNAVAILABLE", async () => {
    post.mockResolvedValue({ data: { status_code: 40000, status_message: "bad" } });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toBeInstanceOf(
      DataForSeoUnavailableError,
    );
  });

  it("maps transport/HTTP failures to DATAFORSEO_UNAVAILABLE", () => {
    expect(() => wrapDataForSeoTransportError(new Error("socket hang up"))).toThrow(
      DataForSeoUnavailableError,
    );
    try {
      wrapDataForSeoTransportError(new Error("socket hang up"));
    } catch (error) {
      expect(error).toBeInstanceOf(DataForSeoUnavailableError);
      expect((error as DataForSeoUnavailableError).code).toBe("DATAFORSEO_UNAVAILABLE");
    }
  });

  it("rejects task-level errors (invalid location) instead of returning zero items", async () => {
    // Observed live: location_name "Charlotte, NC" yields a top-level 20000 with
    // tasks[0].status_code 40501, status_message "Invalid Field: 'location_name'.", result: null.
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [
          { status_code: 40501, status_message: "Invalid Field: 'location_name'.", result: null },
        ],
      },
    });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toBeInstanceOf(
      DataForSeoTaskError,
    );
  });

  it("rejects tasks that return no result array as SERP_EVIDENCE_INVALID", async () => {
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [{ status_code: 20000, status_message: "Ok.", result: [] }],
      },
    });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toBeInstanceOf(
      SerpEvidenceInvalidError,
    );
  });

  it("rejects a malformed task object as SERP_EVIDENCE_INVALID", async () => {
    post.mockResolvedValue({
      data: { status_code: 20000, tasks: [null] },
    });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toBeInstanceOf(
      SerpEvidenceInvalidError,
    );
  });

  it("returns VALID_EMPTY (zero organic items) for a well-formed empty SERP", async () => {
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: [{ datetime: "2024-01-02 12:00:00 +00:00", item_types: ["people_also_ask"], items: [] }],
          },
        ],
      },
    });
    const result = await new DataForSeoClient().getOrganicSerp({ keyword: "x" });
    expect(result.items).toEqual([]);
    expect(result.outcome).toBe("valid_empty");
  });
});

describe("normalizeSerpDatetime", () => {
  it("normalizes DataForSEO datetime to ISO 8601", () => {
    expect(normalizeSerpDatetime("2024-01-02 12:00:00 +00:00")).toBe("2024-01-02T12:00:00.000Z");
  });
  it("returns undefined for empty/absent values", () => {
    expect(normalizeSerpDatetime(undefined)).toBeUndefined();
    expect(normalizeSerpDatetime("")).toBeUndefined();
  });
});
