/**
 * Organization settings use-cases (SPEC.md §6 Settings → Organization).
 * Contract: org-scoped read; update normalizes currency, returns before/after
 * for the audit trail, and 404s on a missing org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    organization: { findUnique: mocks.orgFindUnique, update: mocks.orgUpdate },
  },
}));

import { getOrganizationSettings, updateOrganization } from "@/lib/settings/organization";
import { SettingsError } from "@/lib/settings/errors";

beforeEach(() => vi.clearAllMocks());

describe("getOrganizationSettings", () => {
  it("returns the org config for the tenant", async () => {
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme", currency: "USD", timezone: "UTC" });
    const org = await getOrganizationSettings("org-1");
    expect(org).toEqual({ id: "org-1", name: "Acme", currency: "USD", timezone: "UTC" });
    expect(mocks.orgFindUnique).toHaveBeenCalledWith({
      where: { id: "org-1" },
      select: { id: true, name: true, currency: true, timezone: true },
    });
  });

  it("throws NOT_FOUND when the org does not exist", async () => {
    mocks.orgFindUnique.mockResolvedValue(null);
    await expect(getOrganizationSettings("org-x")).rejects.toBeInstanceOf(SettingsError);
  });
});

describe("updateOrganization", () => {
  it("uppercases currency and returns before/after snapshots", async () => {
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme", currency: "usd", timezone: "UTC" });
    mocks.orgUpdate.mockResolvedValue({ id: "org-1", name: "Acme Inc", currency: "EUR", timezone: "Europe/Berlin" });

    const { before, after } = await updateOrganization("org-1", {
      name: "Acme Inc",
      currency: "eur",
      timezone: "Europe/Berlin",
    });

    expect(mocks.orgUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { name: "Acme Inc", currency: "EUR", timezone: "Europe/Berlin" },
      select: { id: true, name: true, currency: true, timezone: true },
    });
    expect(before.currency).toBe("usd");
    expect(after.currency).toBe("EUR");
  });
});
