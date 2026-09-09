import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.KEY_VERSION = "v1";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  syncRunCreate: vi.fn(),
  syncRunFindMany: vi.fn(),
  webhookFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    loyverseConnection: { findUnique: mocks.findUnique, upsert: mocks.upsert },
    syncRun: { create: mocks.syncRunCreate, findMany: mocks.syncRunFindMany },
    webhookEvent: { findFirst: mocks.webhookFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { validateApiKey } from "@/lib/loyverse/client";
import { connectLoyverse, ConnectError } from "@/lib/loyverse/connect";
import { getLoyverseStatus } from "@/lib/loyverse/status";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (input: string, init: RequestInit) => Response) {
  const spy = vi.fn((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {})),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const storedConnection = {
  id: "conn1",
  organizationId: "org1",
  encryptedApiKey: "v1:aaa:bbb:ccc",
  keyVersion: "v1",
  status: "connected",
  lastSyncAt: null,
  createdAt: new Date("2026-09-09T00:00:00Z"),
  updatedAt: new Date("2026-09-09T00:00:00Z"),
};

describe("validateApiKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a key Loyverse validates, capturing the business name", async () => {
    mockFetch((input, init) => {
      expect(input).toBe("https://api.loyverse.com/v1.0/me");
      expect(init.headers).toMatchObject({ Authorization: "Bearer good-key" });
      return jsonResponse(200, { name: "Test Business" });
    });
    await expect(validateApiKey("good-key")).resolves.toEqual({
      ok: true,
      businessName: "Test Business",
    });
  });

  it.each([401, 403])("maps %i to reason 'invalid'", async (status) => {
    mockFetch(() => jsonResponse(status));
    await expect(validateApiKey("bad-key")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("maps provider 5xx to reason 'unavailable'", async () => {
    mockFetch(() => jsonResponse(500));
    await expect(validateApiKey("key")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps network failure to reason 'unavailable'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(validateApiKey("key")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("connectLoyverse", () => {
  beforeEach(() => {
    mocks.transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    mocks.upsert.mockResolvedValue(storedConnection);
    mocks.syncRunCreate.mockResolvedValue({ id: "run1" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects a key Loyverse does not accept (400 INVALID_LOYVERSE_API_KEY)", async () => {
    mockFetch(() => jsonResponse(401));
    const failure = await connectLoyverse("org1", "bad-key").catch((e) => e);
    expect(failure).toBeInstanceOf(ConnectError);
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("INVALID_LOYVERSE_API_KEY");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects when Loyverse is unreachable (502 LOYVERSE_UNAVAILABLE)", async () => {
    mockFetch(() => jsonResponse(503));
    const failure = await connectLoyverse("org1", "key").catch((e) => e);
    expect(failure).toBeInstanceOf(ConnectError);
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("LOYVERSE_UNAVAILABLE");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("stores only the encrypted envelope with its key version", async () => {
    mockFetch(() => jsonResponse(200, { name: "Biz" }));
    const result = await connectLoyverse("org1", "plaintext-api-key");

    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org1" },
        create: expect.objectContaining({
          organizationId: "org1",
          status: "connected",
        }),
      }),
    );
    const { create } = mocks.upsert.mock.calls[0][0];
    expect(create.encryptedApiKey).not.toContain("plaintext-api-key");
    expect(create.encryptedApiKey.split(":")[0]).toBe("v1");
    expect(create.keyVersion).toBe("v1");
    // And the plaintext must be recoverable server-side (decryptable envelope).
    const { decryptSecret } = await import("@/lib/encryption");
    expect(decryptSecret(create.encryptedApiKey).plaintext).toBe("plaintext-api-key");

    // Response shape is sanitized — no encryptedApiKey field leaks.
    expect(result).not.toHaveProperty("encryptedApiKey");
    expect(result.keyVersion).toBe("v1");
  });

  it("records a QUEUED INITIAL sync run alongside the connection", async () => {
    mockFetch(() => jsonResponse(200, {}));
    await connectLoyverse("org1", "key");
    expect(mocks.syncRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { organizationId: "org1", type: "INITIAL", status: "QUEUED" },
      }),
    );
  });

  it("rejects an empty key before calling Loyverse", async () => {
    const failure = await connectLoyverse("org1", "   ").catch((e) => e);
    expect(failure).toBeInstanceOf(ConnectError);
    expect(failure.status).toBe(400);
  });
});

describe("getLoyverseStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns disconnected defaults when no connection exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.syncRunFindMany.mockResolvedValue([]);
    mocks.webhookFindFirst.mockResolvedValue(null);

    const status = await getLoyverseStatus("org1");
    expect(status.connected).toBe(false);
    expect(status.status).toBe("disconnected");
    expect(status.keyVersion).toBeNull();
    expect(status.recentRuns).toEqual([]);
    expect(status.lastWebhook).toBeNull();
  });

  it("scopes all reads to the given organization and sanitizes output", async () => {
    mocks.findUnique.mockResolvedValue(storedConnection);
    mocks.syncRunFindMany.mockResolvedValue([
      {
        id: "run1",
        type: "INITIAL",
        status: "FAILED",
        startedAt: new Date("2026-09-09T01:00:00Z"),
        finishedAt: new Date("2026-09-09T01:05:00Z"),
        errorSummary: "Loyverse rate limit exceeded",
      },
    ]);
    mocks.webhookFindFirst.mockResolvedValue({
      eventType: "receipts.update",
      status: "PROCESSED",
      receivedAt: new Date("2026-09-09T02:00:00Z"),
    });

    const status = await getLoyverseStatus("org9");
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { organizationId: "org9" } });
    expect(mocks.syncRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org9" } }),
    );
    expect(status.connected).toBe(true);
    expect(status.lastWebhook?.eventType).toBe("receipts.update");
    expect(status.recentRuns[0].errorSummary).toContain("rate limit");
    expect(JSON.stringify(status)).not.toContain("encryptedApiKey");
  });
});
