/**
 * RBAC module matrix per SPEC.md §5.
 *
 * Roles are data-driven via OrganizationMembership.role; this module is the
 * single source of truth for which roles may touch which module. Server-side
 * only — never import this into client components for UI gating decisions
 * ("hidden UI is not authorization", §5); the guard layer enforces it.
 */
import type { Role } from "@prisma/client";

export const MODULES = [
  "SETTINGS",
  "FINANCE",
  "INVENTORY",
  "PURCHASING",
  "TRANSFERS",
  "PRODUCTION",
  "WORKFORCE",
  "PAYROLL",
  "ANALYTICS",
] as const;

export type Module = (typeof MODULES)[number];

/**
 * Role → modules allowed (SPEC.md §5):
 * - OWNER: everything, incl. org config, user/role admin, Loyverse integration
 * - STORE_MANAGER: assigned stores, inventory, POs, transfers, production, ops analytics
 * - ACCOUNTANT: ledger, mappings, AP/AR, P&L, financial exports
 * - WAREHOUSE_STAFF: warehouse inventory, transfers, receiving, adjustments
 * - HR_ADMIN: employees, time data, payroll, leave, labor reports
 */
const MODULE_ROLES: Record<Module, readonly Role[]> = {
  SETTINGS: ["OWNER"],
  FINANCE: ["OWNER", "ACCOUNTANT"],
  INVENTORY: ["OWNER", "STORE_MANAGER", "WAREHOUSE_STAFF"],
  PURCHASING: ["OWNER", "STORE_MANAGER", "WAREHOUSE_STAFF"],
  TRANSFERS: ["OWNER", "STORE_MANAGER", "WAREHOUSE_STAFF"],
  PRODUCTION: ["OWNER", "STORE_MANAGER"],
  WORKFORCE: ["OWNER", "HR_ADMIN"],
  PAYROLL: ["OWNER", "HR_ADMIN"],
  ANALYTICS: ["OWNER", "STORE_MANAGER", "ACCOUNTANT"],
};

export function hasModuleAccess(role: Role, module: Module): boolean {
  return MODULE_ROLES[module].includes(role);
}

/**
 * Roles whose store access may be narrowed by UserStoreAccess rows
 * (SPEC.md §5: "assigned stores").
 */
export function isStoreScoped(role: Role): boolean {
  return role === "STORE_MANAGER";
}

/** Roles whose warehouse access may be narrowed by UserWarehouseAccess rows. */
export function isWarehouseScoped(role: Role): boolean {
  return role === "WAREHOUSE_STAFF";
}
