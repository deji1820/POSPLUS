/**
 * Per-request context (SPEC.md §19 requestId, §24 log correlation).
 *
 * Every API response carries a `requestId`, and the same id appears on the
 * server's log line for that request — so an operator can trace a client
 * error back to the server-side failure without anything sensitive leaving
 * the process.
 *
 * The id travels in an AsyncLocalStorage store populated by the route
 * wrappers (`apiRoute` in lib/api/handler.ts, `withAuth` in
 * lib/auth/guard.ts): envelope helpers read it via `getRequestId()`, so the
 * 30+ call sites never pass it explicitly. An inbound `x-request-id` header
 * is honored (bounded to a safe shape) so upstream proxies/clients can
 * correlate; otherwise a v4 UUID is generated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Inbound ids are trusted only within a bounded, header-safe shape. */
const INBOUND_ID = /^[\w-]{1,64}$/;

/** Resolve the request id: honor a valid inbound header, else generate. */
export function resolveRequestId(req: Request): string {
  const inbound = req.headers.get("x-request-id");
  if (inbound !== null && INBOUND_ID.test(inbound)) return inbound;
  return randomUUID();
}

/** Run `fn` with `requestId` as the ambient request context. */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The ambient request id, or null outside a wrapped request. */
export function getRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
