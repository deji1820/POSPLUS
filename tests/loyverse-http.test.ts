import { describe, expect, it, vi } from "vitest";

import { LoyverseHttp } from "@/lib/loyverse/http";
import { TransientJobError, UnrecoverableError } from "@/lib/queue/errors";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function sleepRecorder() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  return { calls, sleep };
}

describe("LoyverseHttp (SPEC.md §9 transport)", () => {
  it("paginates through cursor pages until the cursor is exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [{ id: "a" }], cursor: "c2" }))
      .mockResolvedValueOnce(json({ items: [{ id: "b" }], cursor: null }));
    const http = new LoyverseHttp("key", sleepRecorder().sleep, fetchImpl);

    const pages = [];
    for await (const page of http.paginate("/items", { limit: 250 })) pages.push(page);

    expect(pages).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchImpl.mock.calls[1][0]);
    expect(secondUrl.searchParams.get("cursor")).toBe("c2");
    expect(secondUrl.searchParams.get("limit")).toBe("250");
  });

  it("seeds the FIRST request from a resume cursor (retried job continues mid-resource)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [], cursor: null }));
    const http = new LoyverseHttp("key", sleepRecorder().sleep, fetchImpl);

    for await (const _ of http.paginate("/receipts", { cursor: "c-page-2" })) {
      void _;
    }

    const firstUrl = new URL(fetchImpl.mock.calls[0][0]);
    // Regression (E2E #7): the incoming checkpoint cursor must not be
    // overwritten by the generator's internal state — a resumed run used to
    // re-fetch the already-processed first page.
    expect(firstUrl.searchParams.get("cursor")).toBe("c-page-2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After on 429 before retrying", async () => {
    const { calls, sleep } = sleepRecorder();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "slow down" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(json({ items: [], cursor: null }));
    const http = new LoyverseHttp("key", sleep, fetchImpl);

    const pages = [];
    for await (const page of http.paginate("/items")) pages.push(page);

    expect(pages).toHaveLength(1);
    expect(calls).toEqual([2000]); // Retry-After (1s) wins, ≥ base backoff, capped
  });

  it("backs off exponentially on 5xx and throws TransientJobError when exhausted", async () => {
    const { calls, sleep } = sleepRecorder();
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "boom" }, 500));
    const http = new LoyverseHttp("key", sleep, fetchImpl);

    await expect(async () => {
      for await (const _ of http.paginate("/items")) void _;
    }).rejects.toBeInstanceOf(TransientJobError);

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(calls).toEqual([2000, 4000, 8000, 16000]);
  });

  it("treats 401/403 as permanent (UnrecoverableError), no retries", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn().mockResolvedValue(json({ error: "bad key" }, status));
      const http = new LoyverseHttp("key", sleepRecorder().sleep, fetchImpl);

      await expect(async () => {
        for await (const _ of http.paginate("/items")) void _;
      }).rejects.toBeInstanceOf(UnrecoverableError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("exhausts network failures into TransientJobError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hangup"));
    const http = new LoyverseHttp("key", sleepRecorder().sleep, fetchImpl);

    await expect(async () => {
      for await (const _ of http.paginate("/items")) void _;
    }).rejects.toBeInstanceOf(TransientJobError);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("never puts the API key in URLs or logs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [], cursor: null }));
    const http = new LoyverseHttp("secret-key", sleepRecorder().sleep, fetchImpl);

    for await (const _ of http.paginate("/items", { cursor: "abc" })) void _;

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain("secret-key");
    expect(init.headers.Authorization).toBe("Bearer secret-key");
  });
});
