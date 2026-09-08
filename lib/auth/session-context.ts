/**
 * Authenticated session context per SPEC.md §5/§18.
 *
 * Resolves the session (Auth.js, #3) into the tenant context every API route
 * and server action must use:
 *
 *   1. The user is authenticated.
 *   2. The user has an ACTIVE membership in an organization (the tenant).
 *   3. Optional store/warehouse scope rows narrow what a scoped role can touch.
 *
 * Node runtime only — this hits the database, so it must never be imported
 * from middleware (Edge). Multi-org: the active org comes from the
 * `posplus_active_org` cookie when valid; otherwise the first ACTIVE
 * membership wins. An org-switcher UI lands with #37.
 */
import { MembershipStatus, type Role } from "@prisma/client";
import { cookies } from "next/headers";

import { auth } from "@/lib/auth";
import { isStoreScoped, isWarehouseScoped } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";

export class AuthContextError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthContextError";
  }
}

export interface SessionContext {
  userId: string;
  email: string;
  /** The authenticated tenant. Every business query must scope by this. */
  orgId: string;
  role: Role;
  /**
   * Allowed store ids, or null when unrestricted within the org.
   * Scoped roles (STORE_MANAGER) with no access rows are unrestricted —
   * UserStoreAccess is an optional restriction per SPEC.md §5.
   */
  storeIds: string[] | null;
  /** Allowed warehouse ids, or null when unrestricted within the org. */
  warehouseIds: string[] | null;
}

const ACTIVE_ORG_COOKIE = "posplus_active_org";

export async function getSessionContext(): Promise<SessionContext> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !session.user?.email) {
    throw new AuthContextError(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const memberships = await prisma.organizationMembership.findMany({
    where: { userId, status: MembershipStatus.ACTIVE },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) {
    throw new AuthContextError(
      403,
      "ORG_MEMBERSHIP_REQUIRED",
      "No active organization membership for this user.",
    );
  }

  // Pick the active org: valid cookie wins, else the oldest membership.
  const cookieOrgId = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const membership =
    memberships.find((m) => m.organizationId === cookieOrgId) ?? memberships[0];

  const [storeRows, warehouseRows] = await Promise.all([
    isStoreScoped(membership.role)
      ? prisma.userStoreAccess.findMany({ where: { userId } })
      : Promise.resolve([]),
    isWarehouseScoped(membership.role)
      ? prisma.userWarehouseAccess.findMany({ where: { userId } })
      : Promise.resolve([]),
  ]);

  return {
    userId,
    email: session.user.email,
    orgId: membership.organizationId,
    role: membership.role,
    storeIds: isStoreScoped(membership.role)
      ? storeRows.length > 0
        ? storeRows.map((row) => row.storeId)
        : null
      : null,
    warehouseIds: isWarehouseScoped(membership.role)
      ? warehouseRows.length > 0
        ? warehouseRows.map((row) => row.warehouseId)
        : null
      : null,
  };
}
