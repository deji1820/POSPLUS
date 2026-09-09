/**
 * Central authorization guard per SPEC.md §5/§18.
 *
 * Every API route and server action must pass through here so that:
 *   1. the record belongs to the authenticated org (orgId on SessionContext —
 *      handlers must scope every query by ctx.orgId), and
 *   2. the role/action permits the module, plus optional store/warehouse scope.
 *
 * Usage (static route):
 *   export const GET = withAuth({ module: "FINANCE" }, async (_req, ctx) => { ... });
 *
 * Usage (dynamic route, store-scoped):
 *   export const GET = withAuth(
 *     { module: "INVENTORY", storeId: (p) => p.id },
 *     async (_req, params, ctx) => { ... },
 *   );
 *
 * Server actions: await requireModule("PAYROLL") at the top of the action.
 *
 * Denials return the SPEC.md §19 envelope; the requestId field lands with #14.
 */
import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/envelope";
import {
  hasModuleAccess,
  type Module,
} from "@/lib/auth/permissions";
import {
  AuthContextError,
  getSessionContext,
  type SessionContext,
} from "@/lib/auth/session-context";

export interface GuardOptions<P = void> {
  module: Module;
  /** Resolve the store id to scope-check from the route params, if any. */
  storeId?: (params: P) => string | undefined;
  /** Resolve the warehouse id to scope-check from the route params, if any. */
  warehouseId?: (params: P) => string | undefined;
}

export function canAccessStore(ctx: SessionContext, storeId: string): boolean {
  return ctx.storeIds === null || ctx.storeIds.includes(storeId);
}

export function canAccessWarehouse(ctx: SessionContext, warehouseId: string): boolean {
  return ctx.warehouseIds === null || ctx.warehouseIds.includes(warehouseId);
}

function deny(error: AuthContextError) {
  return NextResponse.json(apiError(error.code, error.message), { status: error.status });
}

/** Static-route overload: handler receives (request, ctx). */
export function withAuth(
  options: GuardOptions<void>,
  handler: (req: NextRequest, ctx: SessionContext) => Response | Promise<Response>,
): (req: NextRequest, routeCtx?: unknown) => Promise<Response>;

/** Dynamic-route overload: handler receives (request, params, ctx). */
export function withAuth<P>(
  options: GuardOptions<P>,
  handler: (req: NextRequest, params: P, ctx: SessionContext) => Response | Promise<Response>,
): (req: NextRequest, routeCtx: { params: Promise<P> }) => Promise<Response>;

export function withAuth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation params must accept every overload's types in both directions.
  options: GuardOptions<any>,
  handler: (
    req: NextRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paramsOrCtx: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx?: any,
  ) => Response | Promise<Response>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (req: NextRequest, routeCtx?: { params: Promise<any> }) => Promise<Response> {
  return async (req, routeCtx) => {
    try {
      const sessionCtx = await getSessionContext();

      if (!hasModuleAccess(sessionCtx.role, options.module)) {
        throw new AuthContextError(
          403,
          "FORBIDDEN",
          `Role ${sessionCtx.role} does not permit access to module ${options.module}.`,
        );
      }

      // Next 16 always passes a route context object as the second argument,
      // but only sets `params` on dynamic routes — its absence (not the
      // context's presence) is the discriminator between the two overloads.
      const params = routeCtx?.params !== undefined ? await routeCtx.params : undefined;

      const storeId = params !== undefined ? options.storeId?.(params) : undefined;
      if (storeId && !canAccessStore(sessionCtx, storeId)) {
        throw new AuthContextError(
          403,
          "STORE_SCOPE_DENIED",
          "This store is outside your assigned store scope.",
        );
      }
      const warehouseId = params !== undefined ? options.warehouseId?.(params) : undefined;
      if (warehouseId && !canAccessWarehouse(sessionCtx, warehouseId)) {
        throw new AuthContextError(
          403,
          "WAREHOUSE_SCOPE_DENIED",
          "This warehouse is outside your assigned warehouse scope.",
        );
      }

      // Static routes: (req, ctx). Dynamic routes: (req, params, ctx).
      if (params !== undefined) {
        return await handler(req, params, sessionCtx);
      }
      return await (
        handler as (r: NextRequest, c: SessionContext) => Response | Promise<Response>
      )(req, sessionCtx);
    } catch (error) {
      if (error instanceof AuthContextError) return deny(error);
      throw error; // unexpected errors bubble to Next error handling — never leak details here
    }
  };
}

/**
 * Server-action counterpart of withAuth: resolves and validates the session
 * context, throwing AuthContextError on denial. Actions should catch it and
 * return a user-safe error state (never raw messages for 401/403 codes is
 * fine — these messages are intentionally generic).
 */
export async function requireModule(module: Module): Promise<SessionContext> {
  const sessionCtx = await getSessionContext();
  if (!hasModuleAccess(sessionCtx.role, module)) {
    throw new AuthContextError(
      403,
      "FORBIDDEN",
      `Role ${sessionCtx.role} does not permit access to module ${module}.`,
    );
  }
  return sessionCtx;
}
