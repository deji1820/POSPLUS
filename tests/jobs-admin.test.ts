import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQueue: vi.fn(),
}));

vi.mock("@/lib/queue/queues", () => ({
  getQueue: mocks.getQueue,
  isQueueName: (name: string) =>
    [
      "loyverse-webhooks",
      "loyverse-sync",
      "finance-posting",
      "inventory",
      "reorder",
      "payroll",
      "documents",
      "analytics",
    ].includes(name),
}));

import {
  listFailedJobs,
  retryFailedJob,
  UnknownQueueError,
} from "@/lib/queue/admin";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listFailedJobs (SPEC.md §19 dead-letter inspection)", () => {
  it("rejects unknown queue names without touching Redis", async () => {
    await expect(listFailedJobs("not-a-queue")).rejects.toBeInstanceOf(UnknownQueueError);
    expect(mocks.getQueue).not.toHaveBeenCalled();
  });

  it("summarizes failed jobs with safe fields only", async () => {
    mocks.getQueue.mockReturnValue({
      getFailed: vi.fn().mockResolvedValue([
        {
          id: "job-9",
          name: "process-loyverse-webhook",
          attemptsMade: 5,
          failedReason: 'Job "process-loyverse-webhook" is not implemented yet.',
          finishedOn: 1757000000000,
        },
      ]),
    });

    const jobs = await listFailedJobs("loyverse-webhooks");
    expect(jobs).toEqual([
      {
        id: "job-9",
        name: "process-loyverse-webhook",
        queue: "loyverse-webhooks",
        attemptsMade: 5,
        failedReason: 'Job "process-loyverse-webhook" is not implemented yet.',
        finishedOn: 1757000000000,
      },
    ]);
  });
});

describe("retryFailedJob (SPEC.md §19 operator retry control)", () => {
  it("returns false when the job does not exist", async () => {
    mocks.getQueue.mockReturnValue({ getJob: vi.fn().mockResolvedValue(null) });
    expect(await retryFailedJob("loyverse-sync", "missing")).toBe(false);
  });

  it("retries an existing failed job", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    mocks.getQueue.mockReturnValue({ getJob: vi.fn().mockResolvedValue({ retry }) });
    expect(await retryFailedJob("loyverse-sync", "job-1")).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("rejects unknown queues", async () => {
    await expect(retryFailedJob("bogus", "job-1")).rejects.toBeInstanceOf(UnknownQueueError);
  });
});
