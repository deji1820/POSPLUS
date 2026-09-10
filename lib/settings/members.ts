/**
 * Users & roles settings use-cases (SPEC.md §6 "Settings → Users and roles",
 * §5 RBAC, §17 "organization and role changes"). Manage the tenant's
 * memberships: invite a user by email, change their role, activate/deactivate,
 * and narrow a scoped role's store/warehouse access. Org scoped; OWNER only.
 *
 * Adding a user links an EXISTING account by email (this deployment has no
 * outbound email — account creation is via /signup). Deactivation sets the
 * membership status so the user loses access without destroying history.
 */
import { MembershipStatus, Role } from "@prisma/client";
import { z } from "zod";

import { hashPassword } from "@/lib/auth/password";
import { isStoreScoped, isWarehouseScoped } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { SettingsError, validationError } from "@/lib/settings/errors";

export const ROLES: Role[] = [
  "OWNER",
  "STORE_MANAGER",
  "ACCOUNTANT",
  "WAREHOUSE_STAFF",
  "HR_ADMIN",
];

const ROLE_TUPLE = ["OWNER", "STORE_MANAGER", "ACCOUNTANT", "WAREHOUSE_STAFF", "HR_ADMIN"] as [
  Role,
  ...Role[],
];

export const inviteUserSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
  role: z.enum(ROLE_TUPLE),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const changeRoleSchema = z.object({
  membershipId: z.string().min(1),
  role: z.enum(ROLE_TUPLE),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const setMembershipStatusSchema = z.object({
  membershipId: z.string().min(1),
  status: z.enum([MembershipStatus.ACTIVE, MembershipStatus.DISABLED]),
});
export type SetMembershipStatusInput = z.infer<typeof setMembershipStatusSchema>;

export const setStoreScopeSchema = z.object({
  membershipId: z.string().min(1),
  /** Empty = unrestricted within the org (the scoped role sees all stores). */
  storeIds: z.array(z.string().min(1)),
});
export type SetStoreScopeInput = z.infer<typeof setStoreScopeSchema>;

export const setWarehouseScopeSchema = z.object({
  membershipId: z.string().min(1),
  warehouseIds: z.array(z.string().min(1)),
});
export type SetWarehouseScopeInput = z.infer<typeof setWarehouseScopeSchema>;

export interface MembershipSummary {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  status: MembershipStatus;
  storeIds: string[];
  warehouseIds: string[];
}

const membershipSelect = {
  id: true,
  userId: true,
  role: true,
  status: true,
  user: { select: { email: true, name: true } },
} as const;

type MembershipRow = {
  id: string;
  userId: string;
  role: Role;
  status: MembershipStatus;
  user: { email: string; name: string | null };
};

async function summarize(orgId: string, row: MembershipRow): Promise<MembershipSummary> {
  const [storeRows, warehouseRows] = await Promise.all([
    prisma.userStoreAccess.findMany({ where: { userId: row.userId }, select: { storeId: true } }),
    prisma.userWarehouseAccess.findMany({
      where: { userId: row.userId },
      select: { warehouseId: true },
    }),
  ]);
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    role: row.role,
    status: row.status,
    storeIds: storeRows.map((r) => r.storeId),
    warehouseIds: warehouseRows.map((r) => r.warehouseId),
  };
}

/** All memberships in the tenant, with each user's store/warehouse scope. */
export async function listMemberships(orgId: string): Promise<MembershipSummary[]> {
  const rows = await prisma.organizationMembership.findMany({
    where: { organizationId: orgId },
    select: membershipSelect,
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(rows.map((row) => summarize(orgId, row)));
}

/** Resolve a membership owned by this org; 404 otherwise (tenant isolation). */
async function getMembership(orgId: string, membershipId: string): Promise<MembershipRow> {
  const row = await prisma.organizationMembership.findFirst({
    where: { id: membershipId, organizationId: orgId },
    select: membershipSelect,
  });
  if (!row) {
    throw new SettingsError(404, "NOT_FOUND", "Membership not found.");
  }
  return row;
}

/**
 * Link an existing user account into this org with a role. If the email has
 * no account yet, one is created with a random throwaway password (the user
 * resets it via their own signup flow — this deployment sends no email, so
 * the operator shares access out-of-band). Idempotent on (org, user).
 */
export async function inviteUser(
  orgId: string,
  input: InviteUserInput,
): Promise<MembershipSummary> {
  const email = input.email.toLowerCase();
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Create a placeholder account the operator hands off out-of-band. The
    // password is random + unknown to us; it is never returned or logged.
    user = await prisma.user.create({
      data: {
        email,
        name: email.split("@")[0],
        passwordHash: hashPassword(`${crypto.randomUUID()}:${crypto.randomUUID()}`),
      },
    });
  }
  const existing = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
    select: membershipSelect,
  });
  if (existing) {
    throw validationError("That user is already a member of this organization.");
  }
  const row = await prisma.organizationMembership.create({
    data: { organizationId: orgId, userId: user.id, role: input.role },
    select: membershipSelect,
  });
  return summarize(orgId, row);
}

/** Change a member's role (§17 "role changes"). */
export async function changeRole(
  orgId: string,
  input: ChangeRoleInput,
): Promise<{ before: MembershipSummary; after: MembershipSummary }> {
  const row = await getMembership(orgId, input.membershipId);
  if (row.role === input.role) {
    throw validationError(`The user already has the ${input.role} role.`);
  }
  const before = await summarize(orgId, row);
  await prisma.organizationMembership.update({
    where: { id: row.id },
    data: { role: input.role },
  });
  const afterRow = { ...row, role: input.role };
  return { before, after: await summarize(orgId, afterRow) };
}

/** Activate or deactivate a membership (deactivation revokes access). */
export async function setMembershipStatus(
  orgId: string,
  input: SetMembershipStatusInput,
): Promise<{ before: MembershipSummary; after: MembershipSummary }> {
  const row = await getMembership(orgId, input.membershipId);
  if (row.status === input.status) {
    throw validationError(`The membership is already ${input.status.toLowerCase()}.`);
  }
  const before = await summarize(orgId, row);
  await prisma.organizationMembership.update({
    where: { id: row.id },
    data: { status: input.status },
  });
  const afterRow = { ...row, status: input.status };
  return { before, after: await summarize(orgId, afterRow) };
}

/** Replace a user's store scope (only meaningful for store-scoped roles). */
export async function setStoreScope(
  orgId: string,
  input: SetStoreScopeSchemaInput,
): Promise<{ storeIds: string[] }> {
  const row = await getMembership(orgId, input.membershipId);
  if (!isStoreScoped(row.role)) {
    throw validationError(`The ${row.role} role is not narrowed by store scope.`);
  }
  // Validate every store belongs to this tenant.
  if (input.storeIds.length > 0) {
    const count = await prisma.store.count({
      where: { organizationId: orgId, id: { in: input.storeIds } },
    });
    if (count !== input.storeIds.length) {
      throw validationError("One or more selected stores do not belong to this organization.");
    }
  }
  await prisma.$transaction([
    prisma.userStoreAccess.deleteMany({ where: { userId: row.userId } }),
    ...(input.storeIds.length > 0
      ? [
          prisma.userStoreAccess.createMany({
            data: input.storeIds.map((storeId) => ({ userId: row.userId, storeId })),
          }),
        ]
      : []),
  ]);
  return { storeIds: input.storeIds };
}
type SetStoreScopeSchemaInput = SetStoreScopeInput;

/** Replace a user's warehouse scope (only meaningful for warehouse-scoped roles). */
export async function setWarehouseScope(
  orgId: string,
  input: SetWarehouseScopeInput,
): Promise<{ warehouseIds: string[] }> {
  const row = await getMembership(orgId, input.membershipId);
  if (!isWarehouseScoped(row.role)) {
    throw validationError(`The ${row.role} role is not narrowed by warehouse scope.`);
  }
  if (input.warehouseIds.length > 0) {
    const count = await prisma.warehouse.count({
      where: { organizationId: orgId, id: { in: input.warehouseIds } },
    });
    if (count !== input.warehouseIds.length) {
      throw validationError(
        "One or more selected warehouses do not belong to this organization.",
      );
    }
  }
  await prisma.$transaction([
    prisma.userWarehouseAccess.deleteMany({ where: { userId: row.userId } }),
    ...(input.warehouseIds.length > 0
      ? [
          prisma.userWarehouseAccess.createMany({
            data: input.warehouseIds.map((warehouseId) => ({ userId: row.userId, warehouseId })),
          }),
        ]
      : []),
  ]);
  return { warehouseIds: input.warehouseIds };
}
