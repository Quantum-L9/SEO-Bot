/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: {
    post,
    isAxiosError: (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));
const axiosError = (message: string, extras: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { isAxiosError: true, ...extras });
/** The validated env config the client reads; hoisted so assertions can cite it. */
const config = vi.hoisted(() => ({
  DATAFORSEO_LOGIN: "login",
  DATAFORSEO_PASSWORD: "pass",
  DATAFORSEO_TIMEOUT_MS: 90_000,
}));
vi.mock("../../src/core/config.js", () => ({ getConfig: () => config }));

import {
  DataForSeoClient,
  DataForSeoTaskError,
  DataForSeoUnavailableError,
  failureClass,
  isRetryableTaskStatus,
  isRetryableTransportFailure,
  normalizeSerpDatetime,
  retryAfterDelayMs,
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

  it("sends the validated DATAFORSEO_TIMEOUT_MS to axios", async () => {
    post.mockResolvedValue({ data: { status_code: 40000, status_message: "bad" } });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toThrow();
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ timeout: config.DATAFORSEO_TIMEOUT_MS }),
    );
  });

  it("surfaces DataForSEO API errors", async () => {
    post.mockResolvedValue({ data: { status_code: 40000, status_message: "bad" } });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toThrow(
      /DataForSEO error: bad/,
    );
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
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toThrow(
      /DataForSEO task error for "x": Invalid Field: 'location_name'/,
    );
    // Deterministic task errors are never re-submitted.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects tasks that return no result array instead of returning zero items", async () => {
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [{ status_code: 20000, status_message: "Ok.", result: [] }],
      },
    });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: "x" })).rejects.toThrow(
      /DataForSEO task error/,
    );
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

describe("DataForSeoClient bounded retry", () => {
  const call = (client: DataForSeoClient) => client.getOrganicSerp({ keyword: "roofing" });

  it("retries exactly once on a transient 429 and succeeds on the second attempt", async () => {
    post
      .mockRejectedValueOnce(axiosError("rate limited", { response: { status: 429, headers: {} } }))
      .mockResolvedValueOnce({
        data: {
          status_code: 20000,
          tasks: [
            {
              status_code: 20000,
              time: "0.1 sec",
              result: [
                { datetime: "2024-01-02 12:00:00 +00:00", item_types: ["organic"], items: [] },
              ],
            },
          ],
        },
      });
    const client = new DataForSeoClient();
    await expect(call(client)).resolves.toBeTruthy();
    expect(post).toHaveBeenCalledTimes(2);
    expect(client.providerAttempts).toBe(2);
    expect(client.getProviderAttemptLog()).toEqual([
      {
        endpoint: expect.stringContaining("live/advanced"),
        attempt: 1,
        status: "HTTP 429",
        retry: true,
      },
      {
        endpoint: expect.stringContaining("live/advanced"),
        attempt: 2,
        status: "ok",
        retry: false,
      },
    ]);
  });

  it("retries a connection-reset transport failure once", async () => {
    post.mockRejectedValueOnce(axiosError("socket hang up")).mockResolvedValueOnce({
      data: {
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            time: "0.1 sec",
            result: [
              { datetime: "2024-01-02 12:00:00 +00:00", item_types: ["organic"], items: [] },
            ],
          },
        ],
      },
    });
    const client = new DataForSeoClient();
    await expect(call(client)).resolves.toBeTruthy();
    expect(client.providerAttempts).toBe(2);
  });

  it("classifies HTTP statuses: retries only transient provider conditions", () => {
    const transport = (status: number) => ({ isAxiosError: true, response: { status } });
    expect(isRetryableTransportFailure(transport(429))).toBe(true);
    expect(isRetryableTransportFailure(transport(502))).toBe(true);
    expect(isRetryableTransportFailure(transport(503))).toBe(true);
    expect(isRetryableTransportFailure(transport(504))).toBe(true);
    expect(isRetryableTransportFailure(transport(400))).toBe(false);
    expect(isRetryableTransportFailure(transport(401))).toBe(false);
    expect(isRetryableTransportFailure(transport(403))).toBe(false);
  });

  it("retries connection-reset class failures (no HTTP response)", () => {
    expect(isRetryableTransportFailure({ isAxiosError: true })).toBe(true);
    expect(isRetryableTransportFailure({ isAxiosError: true, code: "ECONNABORTED" })).toBe(true);
  });

  it("never retries non-axios or deterministic failures", () => {
    expect(isRetryableTransportFailure(new Error("socket hang up"))).toBe(false);
    expect(isRetryableTransportFailure(new DataForSeoTaskError("task failed"))).toBe(false);
  });

  it("classifies failure status strings without credentials", () => {
    expect(failureClass({ isAxiosError: true, response: { status: 400 } })).toBe("HTTP 400");
    expect(failureClass({ isAxiosError: true, code: "ECONNABORTED" })).toBe("timeout");
    expect(failureClass({ isAxiosError: true })).toBe("network");
    expect(failureClass(new DataForSeoTaskError("task failed"))).toBe("DataForSeoTaskError");
  });

  it("keeps the retry delay bounded and honors Retry-After up to the cap", () => {
    expect(retryAfterDelayMs({ isAxiosError: true, response: { headers: {} } })).toBe(500);
    expect(
      retryAfterDelayMs({ isAxiosError: true, response: { headers: { "retry-after": "1" } } }),
    ).toBe(1000);
    expect(
      retryAfterDelayMs({ isAxiosError: true, response: { headers: { "retry-after": "5" } } }),
    ).toBe(2000);
    expect(retryAfterDelayMs(new Error("x"))).toBe(500);
  });

  it("records attempt telemetry without credentials", () => {
    const client = new DataForSeoClient();
    // The attempt log records endpoint/attempt/status/retry only — assert the
    // record shape directly so no credentials can ever appear in it.
    const record = {
      endpoint: "/serp/google/organic/live/advanced",
      attempt: 1,
      status: "HTTP 429",
      retry: true,
    };
    expect(JSON.stringify(record)).not.toContain("login");
    expect(JSON.stringify(record)).not.toContain("pass");
    expect(client.getProviderAttemptLog()).toEqual([]);
  });
});

describe("DataForSeoClient search-engine task errors (40101)", () => {
  // Observed in the QAP rebuild (2026-11-13): the competitive landscape failed
  // twice on `Internal SE Server Error. (status 40101)` with no record of which
  // portfolio query the search engine rejected.
  const seError = {
    data: {
      status_code: 20000,
      tasks: [{ status_code: 40101, status_message: "Internal SE Server Error.", result: null }],
    },
  };
  const okTask = {
    data: {
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          time: "0.1 sec",
          result: [{ datetime: "2026-11-13 12:00:00 +00:00", item_types: ["organic"], items: [] }],
        },
      ],
    },
  };
  const pauses: number[] = [];
  const client = () =>
    new DataForSeoClient(async (ms) => {
      pauses.push(ms);
    });
  beforeEach(() => {
    pauses.length = 0;
  });

  it("re-submits a task the search engine failed and returns its evidence", async () => {
    post.mockResolvedValueOnce(seError).mockResolvedValueOnce(okTask);
    const c = client();
    await expect(c.getOrganicSerp({ keyword: "ai consulting" })).resolves.toMatchObject({
      items: [],
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(pauses).toEqual([2000]);
    expect(c.getProviderAttemptLog().map((entry) => [entry.status, entry.retry])).toEqual([
      ["task 40101", true],
      ["ok", false],
    ]);
  });

  it("fails closed after three attempts and names the query", async () => {
    post.mockResolvedValue(seError);
    const c = client();
    const failure = c.getOrganicSerp({ keyword: "ai consulting firms" });
    await expect(failure).rejects.toBeInstanceOf(DataForSeoTaskError);
    await expect(failure).rejects.toThrow(
      /task error for "ai consulting firms": Internal SE Server Error\. \(status 40101, after 3 attempts\)/,
    );
    expect(post).toHaveBeenCalledTimes(3);
    expect(c.providerAttempts).toBe(3);
    expect(pauses).toEqual([2000, 2000]);
  });

  it("shares one three-call budget per query across transport and task retries", async () => {
    // Without a shared budget each task submission re-armed the transport
    // retry, so 503 → 40101 → 503 → 40101 → 503 → 40101 cost six billable
    // calls for one query. The budget is per query: the third call is the last.
    const unavailable = () =>
      axiosError("service unavailable", { response: { status: 503, headers: {} } });
    post
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(seError)
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(okTask);
    const c = client();
    await expect(c.getOrganicSerp({ keyword: "ai consulting" })).rejects.toBeInstanceOf(
      DataForSeoUnavailableError,
    );
    expect(post).toHaveBeenCalledTimes(3);
    expect(c.getProviderAttemptLog().map((entry) => [entry.status, entry.retry])).toEqual([
      ["HTTP 503", true],
      ["task 40101", true],
      ["HTTP 503", false],
    ]);
  });

  it("recovers within the shared budget when the last call succeeds", async () => {
    post
      .mockRejectedValueOnce(axiosError("socket hang up"))
      .mockResolvedValueOnce(seError)
      .mockResolvedValueOnce(okTask);
    const c = client();
    await expect(c.getOrganicSerp({ keyword: "ai consulting" })).resolves.toMatchObject({
      items: [],
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("treats only search-engine-side task statuses as retryable", () => {
    expect(isRetryableTaskStatus(40101)).toBe(true);
    for (const status of [20000, 40000, 40006, 40106, 40501, undefined]) {
      expect(isRetryableTaskStatus(status)).toBe(false);
    }
  });
});

describe("DataForSeoClient partial task results (40106)", () => {
  // Observed live: a portfolio query SEO-Bot added while filling donors
  // ("turn crm data into revenue company") came back 40106. DataForSEO had
  // already retried the pages it could not retrieve and did not charge for
  // them. The result array is usable evidence; resubmitting spends another call.
  const keyword = "turn crm data into revenue company";
  const pauses: number[] = [];
  const client = () =>
    new DataForSeoClient(async (ms) => {
      pauses.push(ms);
    });
  beforeEach(() => {
    pauses.length = 0;
  });

  function taskResponse(result: unknown) {
    return {
      data: {
        status_code: 20000,
        tasks: [
          {
            status_code: 40106,
            status_message: "Some pages could not be retrieved after retries and were not charged.",
            time: "0.4 sec",
            result,
          },
        ],
      },
    };
  }

  const partialResult = [
    {
      datetime: "2026-11-17 18:00:00 +00:00",
      item_types: ["organic", "paid"],
      items: [
        { type: "paid", rank_absolute: 1, url: "https://ads.example.com" },
        {
          type: "organic",
          rank_group: 1,
          rank_absolute: 2,
          url: "https://www.Example.com/crm",
          title: "CRM",
          description: "revenue",
        },
      ],
    },
  ];

  it("parses a 40106 result array the same way as a completed task and records it partial", async () => {
    post.mockResolvedValue(taskResponse(partialResult));
    const c = client();
    const result = await c.getOrganicSerp({ keyword });
    expect(result.items).toEqual([
      expect.objectContaining({
        rankGroup: 1,
        rankAbsolute: 2,
        domain: "example.com",
        url: "https://www.Example.com/crm",
        title: "CRM",
        snippet: "revenue",
      }),
    ]);
    expect(result.observedAt).toBe("2026-11-17T18:00:00.000Z");
    expect(result.serpFeatures).toEqual(["organic", "paid"]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
    expect(c.getProviderAttemptLog()).toEqual([
      {
        endpoint: "/serp/google/organic/live/advanced",
        attempt: 1,
        status: "task 40106 partial",
        retry: false,
      },
    ]);
  });

  it("treats a 40106 result with an empty item list as a valid empty query", async () => {
    post.mockResolvedValue(
      taskResponse([
        {
          datetime: "2026-11-17 18:00:00 +00:00",
          item_types: ["organic"],
          items: [],
        },
      ]),
    );
    const c = client();
    await expect(c.getOrganicSerp({ keyword })).resolves.toMatchObject({ items: [] });
    expect(post).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
    expect(c.getProviderAttemptLog().map((entry) => [entry.status, entry.retry])).toEqual([
      ["task 40106 partial", false],
    ]);
  });

  it("fails closed when a 40106 task has no result array and does not resubmit", async () => {
    post.mockResolvedValue(taskResponse(null));
    const c = client();
    const failure = c.getOrganicSerp({ keyword });
    await expect(failure).rejects.toBeInstanceOf(DataForSeoTaskError);
    await expect(failure).rejects.toThrow(
      /task error for "turn crm data into revenue company": .* \(status 40106\)/,
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
    expect(c.getProviderAttemptLog().map((entry) => [entry.status, entry.retry])).toEqual([
      ["task 40106", false],
    ]);
  });
});
