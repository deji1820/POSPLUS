/**
 * Payroll rules + dashboard preferences use-cases (SPEC.md §6 Settings).
 * Payroll: deduction rules validate rate XOR fixed amount, normalize to
 * Decimal, and return before/after; payroll periods validate start<=end and
 * reject exact duplicates. Dashboard prefs: per-user upsert with scalar
 * scope/period round-trip through the Json columns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deductionFindMany: vi.fn(),
  deductionFindFirst: vi.fn(),
  deductionCreate: vi.fn(),
  deductionUpdate: vi.fn(),
  periodFindMany: vi.fn(),
  periodFindFirst: vi.fn(),
  periodCreate: vi.fn(),
  prefFindUnique: vi.fn(),
  prefUpsert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    statutoryDeductionRule: {
      findMany: mocks.deductionFindMany,
      findFirst: mocks.deductionFindFirst,
      create: mocks.deductionCreate,
      update: mocks.deductionUpdate,
    },
    payrollPeriod: {
      findMany: mocks.periodFindMany,
      findFirst: mocks.periodFindFirst,
      create: mocks.periodCreate,
    },
    dashboardPreference: { findUnique: mocks.prefFindUnique, upsert: mocks.prefUpsert },
  },
}));

import {
  createDeduction,
  createPayrollPeriod,
  updateDeduction,
} from "@/lib/settings/payroll";
import {
  getDashboardPreference,
  saveDashboardPreference,
} from "@/lib/settings/dashboard-preferences";
import { SettingsError } from "@/lib/settings/errors";
import { deductionInputSchema, payrollPeriodInputSchema } from "@/lib/settings/payroll";
import { dashboardPreferenceSchema } from "@/lib/settings/dashboard-preferences";

beforeEach(() => vi.clearAllMocks());

describe("statutory deduction rules", () => {
  it("schema requires a rate or a fixed amount", () => {
    expect(
      deductionInputSchema.safeParse({ name: "X", effectiveFrom: "2026-01-01" }).success,
    ).toBe(false);
    expect(
      deductionInputSchema.safeParse({ name: "X", rate: "5", effectiveFrom: "2026-01-01" }).success,
    ).toBe(true);
  });

  it("schema bounds the rate to 0-100", () => {
    expect(
      deductionInputSchema.safeParse({ name: "X", rate: "150", effectiveFrom: "2026-01-01" }).success,
    ).toBe(false);
  });

  it("create stores rate and returns a summary", async () => {
    mocks.deductionCreate.mockResolvedValue({
      id: "d-1",
      name: "Social Security",
      rate: { toString: () => "5.0000" },
      fixedAmount: null,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    });
    const created = await createDeduction("org-1", { name: "Social Security", rate: "5", fixedAmount: undefined, effectiveFrom: "2026-01-01" });
    expect(created.id).toBe("d-1");
    expect(created.rate).toBe("5.0000");
  });

  it("update returns before/after and 404s out of tenant", async () => {
    mocks.deductionFindFirst.mockResolvedValueOnce(null);
    await expect(
      updateDeduction("org-1", { id: "d-x", name: "X", rate: "5", fixedAmount: undefined, effectiveFrom: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const before = { id: "d-1", name: "Old", rate: null, fixedAmount: { toString: () => "10.00" }, effectiveFrom: new Date("2026-01-01T00:00:00Z") };
    mocks.deductionFindFirst.mockResolvedValueOnce(before);
    mocks.deductionUpdate.mockResolvedValue({ ...before, name: "New" });
    const result = await updateDeduction("org-1", { id: "d-1", name: "New", rate: undefined, fixedAmount: "10", effectiveFrom: "2026-01-01" });
    expect(result.before.name).toBe("Old");
    expect(result.after.name).toBe("New");
  });
});

describe("payroll periods", () => {
  it("schema requires end >= start", () => {
    expect(
      payrollPeriodInputSchema.safeParse({ name: "P", startDate: "2026-09-10", endDate: "2026-09-01" }).success,
    ).toBe(false);
    expect(
      payrollPeriodInputSchema.safeParse({ name: "P", startDate: "2026-09-01", endDate: "2026-09-30" }).success,
    ).toBe(true);
  });

  it("rejects an exact duplicate period", async () => {
    mocks.periodFindFirst.mockResolvedValue({ id: "pp-1" });
    await expect(
      createPayrollPeriod("org-1", { name: "Sept", startDate: "2026-09-01", endDate: "2026-09-30" }),
    ).rejects.toBeInstanceOf(SettingsError);
  });

  it("creates a period", async () => {
    mocks.periodFindFirst.mockResolvedValue(null);
    mocks.periodCreate.mockResolvedValue({ id: "pp-1", name: "Sept", startDate: new Date("2026-09-01T00:00:00Z"), endDate: new Date("2026-09-30T00:00:00Z") });
    const created = await createPayrollPeriod("org-1", { name: "Sept", startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(created.id).toBe("pp-1");
  });
});

describe("dashboard preferences", () => {
  it("schema validates mode", () => {
    expect(dashboardPreferenceSchema.safeParse({ mode: "stores" }).success).toBe(true);
    expect(dashboardPreferenceSchema.safeParse({ mode: "bogus" }).success).toBe(false);
  });

  it("returns null fields when unset", async () => {
    mocks.prefFindUnique.mockResolvedValue(null);
    const pref = await getDashboardPreference("org-1", "u-1");
    expect(pref).toEqual({ mode: null, scope: null, period: null });
  });

  it("upserts and round-trips scalar scope/period", async () => {
    mocks.prefUpsert.mockResolvedValue({ mode: "stores", scope: { value: "store-1" }, period: { preset: "this_month" } });
    const saved = await saveDashboardPreference("org-1", "u-1", { mode: "stores", scope: "store-1", period: "this_month" });
    expect(saved.mode).toBe("stores");
    expect(saved.scope).toBe("store-1");
    expect(saved.period).toBe("this_month");
  });
});
