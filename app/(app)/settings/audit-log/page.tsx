/**
 * /settings/audit-log — SPEC.md §6 "Settings → Audit log", §17 Auditability.
 * A filterable, org-scoped browser over the AuditLog table, powered by the
 * #15 read model (lib/audit/list.ts). Filters ride the URL (GET form) so a
 * filtered view is linkable; deep pages cursor-paginate without offset churn.
 * Every setting the Owner changes through the UI lands here — this page is
 * the acceptance surface for "every change appears in the audit log".
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import {
  listAuditEntries,
  type AuditEntrySummary,
} from "@/lib/audit/list";
import { prisma } from "@/lib/db";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function deny(message: string) {
  return (
    <section>
      <h1 className="text-xl font-semibold">Audit Log</h1>
      <p className="mt-2 text-sm text-red-700">{message}</p>
    </section>
  );
}

const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** Render a JSON snapshot as compact key: value chips, or an em-dash. */
function JsonChips({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-gray-400">—</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  if (entries.length === 0) return <span className="text-gray-400">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
        </span>
      ))}
    </span>
  );
}

function AuditRow({ entry, actorEmail }: { entry: AuditEntrySummary; actorEmail: string | null }) {
  return (
    <tr className="border-b align-top last:border-0">
      <td className="whitespace-nowrap px-3 py-2 text-sm text-gray-500">
        {dateTime.format(new Date(entry.createdAt))}
      </td>
      <td className="px-3 py-2 text-sm">
        <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
          {entry.action}
        </span>
      </td>
      <td className="px-3 py-2 text-sm text-gray-600">
        {entry.entityType}
        <span className="ml-1 text-xs text-gray-400">{entry.entityId.slice(0, 8)}</span>
      </td>
      <td className="px-3 py-2 text-sm">{actorEmail ?? <span className="text-gray-400">system</span>}</td>
      <td className="px-3 py-2 text-sm">
        <div className="flex flex-col gap-1">
          {entry.beforeJson !== null && (
            <span className="flex items-center gap-1 text-xs text-red-700">
              <span className="font-medium">before</span> <JsonChips value={entry.beforeJson} />
            </span>
          )}
          {entry.afterJson !== null && (
            <span className="flex items-center gap-1 text-xs text-green-700">
              <span className="font-medium">after</span> <JsonChips value={entry.afterJson} />
            </span>
          )}
          {entry.metadataJson !== null && (
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <span className="font-medium">meta</span> <JsonChips value={entry.metadataJson} />
            </span>
          )}
          {entry.beforeJson === null && entry.afterJson === null && entry.metadataJson === null && (
            <span className="text-gray-400">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) return deny(error.message);
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "SETTINGS")) {
    return deny("Your role does not permit access to organization settings.");
  }

  // The GET form submits every control, so unset filters arrive as "" —
  // normalize to undefined or the reader's zod schema rejects them (min(1)).
  const pick = (value: string | undefined) => (value ? value : undefined);
  const filters = {
    action: pick(first(params.action)),
    entityType: pick(first(params.entityType)),
    actorUserId: pick(first(params.actorUserId)),
    from: pick(first(params.from)),
    to: pick(first(params.to)),
    cursor: pick(first(params.cursor)),
    limit: 50,
  };

  const [{ entries, nextCursor }, members] = await Promise.all([
    listAuditEntries(ctx.orgId, filters),
    prisma.organizationMembership.findMany({
      where: { organizationId: ctx.orgId },
      select: { userId: true, user: { select: { email: true } } },
    }),
  ]);
  const emailByUserId = new Map(members.map((m) => [m.userId, m.user.email]));

  // Distinct actions/entity types present, to populate the filter dropdowns.
  const [actionRows, typeRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId: ctx.orgId },
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
      take: 200,
    }),
    prisma.auditLog.findMany({
      where: { organizationId: ctx.orgId },
      select: { entityType: true },
      distinct: ["entityType"],
      orderBy: { entityType: "asc" },
      take: 200,
    }),
  ]);

  const selectClass = "rounded border bg-white px-2 py-1 text-sm dark:bg-gray-900";
  const thClass =
    "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";

  const baseQuery = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === "string" && v && k !== "cursor") baseQuery.set(k, v);
  }

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Audit Log</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Every change made through the settings pages — and every critical system event — is
          recorded here, newest first.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded border p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Action
          <select name="action" defaultValue={filters.action ?? ""} className={selectClass}>
            <option value="">All actions</option>
            {actionRows.map((r) => (
              <option key={r.action} value={r.action}>{r.action}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Entity type
          <select name="entityType" defaultValue={filters.entityType ?? ""} className={selectClass}>
            <option value="">All types</option>
            {typeRows.map((r) => (
              <option key={r.entityType} value={r.entityType}>{r.entityType}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          Actor
          <select name="actorUserId" defaultValue={filters.actorUserId ?? ""} className={selectClass}>
            <option value="">All actors</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>{m.user.email}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          From
          <input name="from" type="date" defaultValue={filters.from?.slice(0, 10) ?? ""} className={selectClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          To
          <input name="to" type="date" defaultValue={filters.to?.slice(0, 10) ?? ""} className={selectClass} />
        </label>
        <button type="submit" className="rounded bg-black px-3 py-1 text-sm text-white dark:bg-white dark:text-black">
          Filter
        </button>
        <a href="/settings/audit-log" className="text-sm text-gray-500 underline">
          Reset
        </a>
      </form>

      <div className="rounded border">
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-gray-500">
            No audit entries match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className={thClass}>When</th>
                  <th className={thClass}>Action</th>
                  <th className={thClass}>Entity</th>
                  <th className={thClass}>Actor</th>
                  <th className={thClass}>Change</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    actorEmail={entry.actorUserId ? (emailByUserId.get(entry.actorUserId) ?? null) : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {nextCursor && (
        <div className="flex justify-end">
          <a
            href={`/settings/audit-log?${baseQuery.toString()}&cursor=${nextCursor}`}
            className="rounded border px-3 py-1.5 text-sm"
          >
            Older entries →
          </a>
        </div>
      )}
    </section>
  );
}
