/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && (error as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));
const axiosError = (message: string, extras: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { isAxiosError: true, ...extras });
vi.mock("../../src/core/config.js", () => ({
  getConfig: () => ({ DATAFORSEO_LOGIN: "login", DATAFORSEO_PASSWORD: "password" }),
}));

import {
  DataForSeoClient,
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  SerpEvidenceInvalidError,
} from "../../src/services/dataforseo.js";

const post = vi.mocked(axios.post);

function apiResponse(task: unknown) {
  return { data: { status_code: 20000, status_message: "Ok.", tasks: [task] } };
}

function organicItem(rank: number, url: string) {
  return {
    type: "organic",
    rank_group: rank,
    rank_absolute: rank,
    url,
    title: `Result ${rank}`,
    description: "snippet",
  };
}

function okTask(items: unknown[]) {
  return {
    status_code: 20000,
    status_message: "Ok.",
    time: "2024-01-01 00:00:00 +00:00",
    result: [
      {
        datetime: "2024-01-01 00:00:00 +00:00",
        item_types: ["organic"],
        items,
      },
    ],
  };
}

beforeEach(() => {
  post.mockReset();
});

describe("getOrganicSerp — valid evidence", () => {
  it("normalizes a real-shaped organic response", async () => {
    post.mockResolvedValue(
      apiResponse(
        okTask([
          organicItem(1, "https://www.alpha-roofing.com/metal"),
          { type: "paid", rank_group: 1, url: "https://ads.example.com" },
          organicItem(2, "https://beta-roofs.com/"),
        ]) as never,
      ) as never,
    );

    const result = await new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      rankGroup: 1,
      url: "https://www.alpha-roofing.com/metal",
      domain: "alpha-roofing.com",
    });
    expect(result.observedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(result.serpFeatures).toEqual(["organic"]);
  });

  it("treats a task that ran and found nothing as a VALID EMPTY RESULT", async () => {
    post.mockResolvedValue(apiResponse(okTask([]) as never) as never);
    const result = await new DataForSeoClient().getOrganicSerp({ keyword: "no results here" });
    expect(result.items).toEqual([]);
  });

  it("treats a null items field as a valid empty result, not a failure", async () => {
    const task = okTask([]);
    (task.result[0] as Record<string, unknown>).items = null;
    post.mockResolvedValue(apiResponse(task as never) as never);
    const result = await new DataForSeoClient().getOrganicSerp({ keyword: "sparse" });
    expect(result.items).toEqual([]);
  });
});

describe("getOrganicSerp — provider failures never become empty evidence", () => {
  it("throws DATAFORSEO_UNAVAILABLE on a transport failure", async () => {
    post.mockRejectedValue(axiosError("connect ETIMEDOUT") as never);
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toBeInstanceOf(DataForSeoUnavailableError);
  });

  it("throws DATAFORSEO_UNAVAILABLE on a non-20000 top-level status", async () => {
    post.mockResolvedValue({
      data: { status_code: 40200, status_message: "Payment Required." },
    } as never);
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toMatchObject({ code: "DATAFORSEO_UNAVAILABLE" });
  });

  it("throws DATAFORSEO_TASK_ERROR on a task-level error", async () => {
    post.mockResolvedValue(
      apiResponse({
        status_code: 40501,
        status_message: "Invalid Field: 'location_name'.",
        result: null,
      } as never) as never,
    );
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toBeInstanceOf(DataForSeoTaskError);
  });

  it("throws DATAFORSEO_TASK_ERROR when the task returns no result container", async () => {
    post.mockResolvedValue(
      apiResponse({ status_code: 20000, status_message: "Ok.", result: [] } as never) as never,
    );
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toMatchObject({ code: "DATAFORSEO_TASK_ERROR" });
  });

  it("throws SERP_EVIDENCE_INVALID for a malformed items payload", async () => {
    const task = okTask([]);
    (task.result[0] as Record<string, unknown>).items = "not-an-array";
    post.mockResolvedValue(apiResponse(task as never) as never);
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toBeInstanceOf(SerpEvidenceInvalidError);
  });

  it("throws SERP_EVIDENCE_INVALID for an organic item with no usable rank", async () => {
    post.mockResolvedValue(
      apiResponse(
        okTask([
          { type: "organic", url: "https://alpha.com/a", rank_group: null, rank_absolute: null },
        ]) as never,
      ) as never,
    );
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toMatchObject({ code: "SERP_EVIDENCE_INVALID" });
  });

  it("throws SERP_EVIDENCE_INVALID for an organic item with an unparseable URL", async () => {
    post.mockResolvedValue(
      apiResponse(okTask([{ type: "organic", rank_group: 1, url: "not a url" }]) as never) as never,
    );
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toBeInstanceOf(SerpEvidenceInvalidError);
  });

  it("never returns zero observations for a failed request", async () => {
    post.mockRejectedValue(axiosError("500 Internal Server Error", { response: { status: 500, headers: {} } }) as never);
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).rejects.toThrow();
    // The only way to observe zero items is a task that actually succeeded.
    post.mockReset();
    post.mockResolvedValue(apiResponse(okTask([]) as never) as never);
    await expect(
      new DataForSeoClient().getOrganicSerp({ keyword: "metal roofing" }),
    ).resolves.toMatchObject({ items: [] });
  });
});
