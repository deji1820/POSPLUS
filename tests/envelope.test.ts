import { describe, expect, it } from "vitest";
import { apiError, ok } from "@/lib/api/envelope";

describe("API envelope (SPEC.md §19)", () => {
  it("builds an ok envelope", () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });

  it("builds an error envelope with code, message, and default details", () => {
    const envelope = apiError("PURCHASE_ORDER_INVALID_STATE", "Invalid state.");
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("PURCHASE_ORDER_INVALID_STATE");
    expect(envelope.error.message).toBe("Invalid state.");
    expect(envelope.error.details).toEqual({});
  });
});
