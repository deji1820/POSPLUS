/**
 * /settings/loyverse — SPEC.md §6 "Loyverse Connection".
 * Connection status, key version, last successful sync, last webhook
 * received, manual "Sync now", and operator-safe sync history. The stored
 * API key is never rendered anywhere on this page.
 */
import { AuthContextError, getSessionContext } from "@/lib/auth/session-context";
import { hasModuleAccess } from "@/lib/auth/permissions";
import { getLoyverseStatus, type LoyverseStatus } from "@/lib/loyverse/status";

import { ConnectForm } from "./connect-form";
import { SyncNowButton } from "./sync-now-button";

const dateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: Date | null): string {
  return value ? dateTime.format(value) : "—";
}

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={
        connected
          ? "rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-800"
          : "rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600"
      }
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function StatusCard({ status }: { status: LoyverseStatus }) {
  return (
    <div className="rounded border p-4">
      <div className="flex items-center gap-3">
        <StatusBadge connected={status.connected} />
        <span className="text-sm text-gray-500">Key version: {status.keyVersion ?? "—"}</span>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-gray-500">Last successful sync</dt>
          <dd>{formatDate(status.lastSyncAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Last webhook received</dt>
          <dd>
            {status.lastWebhook
              ? `${status.lastWebhook.eventType} · ${formatDate(status.lastWebhook.receivedAt)} (${status.lastWebhook.status})`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Recent runs</dt>
          <dd>{status.recentRuns.length}</dd>
        </div>
      </dl>
      {status.connected && (
        <div className="mt-4">
          <SyncNowButton />
        </div>
      )}
    </div>
  );
}

function SyncHistory({ runs }: { runs: LoyverseStatus["recentRuns"] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-gray-500">No sync runs yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-gray-500">
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">Started</th>
            <th className="py-2 pr-4 font-medium">Finished</th>
            <th className="py-2 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b last:border-0">
              <td className="py-2 pr-4">{run.type}</td>
              <td className="py-2 pr-4">{run.status}</td>
              <td className="py-2 pr-4">{formatDate(run.startedAt)}</td>
              <td className="py-2 pr-4">{formatDate(run.finishedAt)}</td>
              <td className="py-2 text-red-700">{run.errorSummary ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function LoyverseSettingsPage() {
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch (error) {
    if (error instanceof AuthContextError) {
      return (
        <section>
          <h1 className="text-xl font-semibold">Loyverse Connection</h1>
          <p className="mt-2 text-sm text-red-700">{error.message}</p>
        </section>
      );
    }
    throw error;
  }

  if (!hasModuleAccess(ctx.role, "SETTINGS")) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Loyverse Connection</h1>
        <p className="mt-2 text-sm text-red-700">
          Your role does not permit access to organization settings.
        </p>
      </section>
    );
  }

  const status = await getLoyverseStatus(ctx.orgId);

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Loyverse Connection</h1>
      <StatusCard status={status} />
      <div className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium">
          {status.connected ? "Replace API key" : "Connect"}
        </h2>
        <ConnectForm />
      </div>
      <div className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium">Sync history</h2>
        <SyncHistory runs={status.recentRuns} />
      </div>
    </section>
  );
}
