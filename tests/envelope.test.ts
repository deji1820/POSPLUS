import { describe, expect, it } from "vitest";

import { apiError, ok } from "@/lib/api/envelope";
import { getRequestId, runWithRequestContext } from "@/lib/api/request-context";

describe("API envelope (SPEC.md §19)", () => {
  it("builds an ok envelope with a requestId on every response", () => {
    const envelope = ok({ a: 1 });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ a: 1 });
    expect(typeof envelope.requestId).toBe("string");
    expect(envelope.requestId.length).toBeGreaterThan(0);
  });

  it("builds an error envelope with code, message, and default details", () => {
    const envelope = apiError("PURCHASE_ORDER_INVALID_STATE", "Invalid state.");
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("PURCHASE_ORDER_INVALID_STATE");
    expect(envelope.error.message).toBe("Invalid state.");
    expect(envelope.error.details).toEqual({});
    expect(envelope.requestId.length).toBeGreaterThan(0);
  });

  it("uses the ambient request context id when inside a wrapped request", () => {
    runWithRequestContext("req-abc-123", () => {
      expect(ok({}).requestId).toBe("req-abc-123");
      expect(apiError("NOT_FOUND", "nope").requestId).toBe("req-abc-123");
    });
  });

  it("exposes the ambient request id via getRequestId", () => {
    expect(getRequestId()).toBeNull();
    runWithRequestContext("req-xyz", () => {
      expect(getRequestId()).toBe("req-xyz");
    });
    expect(getRequestId()).toBeNull();
  });
});
