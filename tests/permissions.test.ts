import type { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  hasModuleAccess,
  isStoreScoped,
  isWarehouseScoped,
  MODULES,
  type Module,
} from "@/lib/auth/permissions";

/** Exact allow-list per role, from SPEC.md §5. */
const EXPECTED: Record<Role, Module[]> = {
  OWNER: [...MODULES],
  STORE_MANAGER: ["INVENTORY", "PURCHASING", "TRANSFERS", "PRODUCTION", "ANALYTICS"],
  ACCOUNTANT: ["FINANCE", "ANALYTICS"],
  WAREHOUSE_STAFF: ["INVENTORY", "PURCHASING", "TRANSFERS"],
  HR_ADMIN: ["WORKFORCE", "PAYROLL"],
};

describe("RBAC module matrix (SPEC.md §5)", () => {
  it.each(Object.keys(EXPECTED) as Role[])("role %s matches the SPEC allow-list exactly", (role) => {
    for (const mod of MODULES) {
      expect(hasModuleAccess(role, mod)).toBe(EXPECTED[role].includes(mod));
    }
  });

  it("denies every module for unknown roles by default (fail-closed)", () => {
    for (const mod of MODULES) {
      expect(hasModuleAccess("NOPE" as Role, mod)).toBe(false);
    }
  });

  it("only STORE_MANAGER is store-scoped", () => {
    expect(isStoreScoped("STORE_MANAGER")).toBe(true);
    for (const role of ["OWNER", "ACCOUNTANT", "WAREHOUSE_STAFF", "HR_ADMIN"] as Role[]) {
      expect(isStoreScoped(role)).toBe(false);
    }
  });

  it("only WAREHOUSE_STAFF is warehouse-scoped", () => {
    expect(isWarehouseScoped("WAREHOUSE_STAFF")).toBe(true);
    for (const role of ["OWNER", "STORE_MANAGER", "ACCOUNTANT", "HR_ADMIN"] as Role[]) {
      expect(isWarehouseScoped(role)).toBe(false);
    }
  });
});
