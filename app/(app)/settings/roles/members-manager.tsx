"use client";

import { useActionState, useState } from "react";
import type { MembershipStatus, Role } from "@prisma/client";

import {
  initialSettingsState,
  type SettingsActionState,
} from "@/lib/settings/state";

import {
  changeRoleAction,
  inviteUserAction,
  setMembershipStatusAction,
  setStoreScopeAction,
  setWarehouseScopeAction,
} from "./actions";

interface Member {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  status: MembershipStatus;
  storeIds: string[];
  warehouseIds: string[];
}

interface Option {
  id: string;
  name: string;
}

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  STORE_MANAGER: "Store Manager",
  ACCOUNTANT: "Accountant",
  WAREHOUSE_STAFF: "Warehouse Staff",
  HR_ADMIN: "HR Admin",
};

const ROLES: Role[] = ["OWNER", "STORE_MANAGER", "ACCOUNTANT", "WAREHOUSE_STAFF", "HR_ADMIN"];
const STORE_SCOPED: Role[] = ["STORE_MANAGER"];
const WAREHOUSE_SCOPED: Role[] = ["WAREHOUSE_STAFF"];

function InviteForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    async (prev, formData) => {
      const result = await inviteUserAction(prev, formData);
      if (result.ok) onDone();
      return result;
    },
    initialSettingsState,
    );
  return (
    <form action={formAction} className="grid grid-cols-1 gap-2 sm:grid-cols-6 sm:items-end">
      <label className="flex flex-col gap-1 text-xs sm:col-span-3">
        Email
        <input name="email" type="email" required placeholder="user@example.com" className="rounded border p-1.5 text-sm" />
      </label>
      <label className="flex flex-col gap-1 text-xs sm:col-span-2">
        Role
        <select name="role" className="rounded border p-1.5 text-sm">
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:col-span-1 sm:text-right">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {state.message && !state.ok && <p className="text-sm text-red-700 sm:col-span-6">{state.message}</p>}
    </form>
  );
}

function RoleControl({ member }: { member: Member }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    changeRoleAction,
    initialSettingsState,
    );
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="membershipId" value={member.id} />
      <select name="role" defaultValue={member.role} className="rounded border p-1 text-sm">
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="rounded border px-2 py-1 text-xs disabled:opacity-50">
        {pending ? "…" : "Set"}
      </button>
      {state.message && !state.ok && <span className="text-xs text-red-700">{state.message}</span>}
    </form>
  );
}

function StatusControl({ member }: { member: Member }) {
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    setMembershipStatusAction,
    initialSettingsState,
    );
  const deactivate = member.status === "ACTIVE";
  return (
    <form action={formAction}>
      <input type="hidden" name="membershipId" value={member.id} />
      <input type="hidden" name="status" value={deactivate ? "DISABLED" : "ACTIVE"} />
      <button
        type="submit"
        disabled={pending}
        className={
          deactivate
            ? "rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
            : "rounded border border-green-300 px-2 py-1 text-xs text-green-700 disabled:opacity-50"
        }
      >
        {pending ? "…" : deactivate ? "Deactivate" : "Reactivate"}
      </button>
      {state.message && !state.ok && <span className="ml-2 text-xs text-red-700">{state.message}</span>}
    </form>
  );
}

function ScopeEditor({
  member,
  kind,
  options,
  assigned,
}: {
  member: Member;
  kind: "store" | "warehouse";
  options: Option[];
  assigned: string[];
}) {
  const action = kind === "store" ? setStoreScopeAction : setWarehouseScopeAction;
  const name = kind === "store" ? "storeIds" : "warehouseIds";
  const label = kind === "store" ? "store" : "warehouse";
  const [state, formAction, pending] = useActionState<SettingsActionState, FormData>(
    action,
    initialSettingsState,
    );
  const [selected, setSelected] = useState<string[]>(assigned);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <form action={formAction} className="rounded border p-3">
      <input type="hidden" name="membershipId" value={member.id} />
      <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
        {kind === "store" ? "Store" : "Warehouse"} scope — leave all unchecked for unrestricted
        access to every {label} in the org.
      </p>
      {options.length === 0 ? (
        <p className="text-xs text-gray-500">No {label}s defined yet.</p>
      ) : (
        <div className="mb-3 flex flex-wrap gap-3">
          {options.map((opt) => (
            <label key={opt.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name={name}
                value={opt.id}
                checked={selected.includes(opt.id)}
                onChange={() => toggle(opt.id)}
              />
              {opt.name}
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded bg-gray-900 px-3 py-1 text-xs text-white disabled:opacity-50">
          {pending ? "Saving…" : "Save scope"}
        </button>
        {state.message && (
          <span className={state.ok ? "text-xs text-green-700" : "text-xs text-red-700"}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

function MemberRow({
  member,
  stores,
  warehouses,
}: {
  member: Member;
  stores: Option[];
  warehouses: Option[];
}) {
  return (
    <div className="rounded border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {member.name ?? member.email}
            {member.name && <span className="ml-2 text-sm font-normal text-gray-500">{member.email}</span>}
          </p>
          <p className="mt-0.5 text-xs">
            <span
              className={
                member.status === "ACTIVE"
                  ? "rounded bg-green-100 px-2 py-0.5 text-green-800"
                  : "rounded bg-gray-100 px-2 py-0.5 text-gray-600"
              }
            >
              {member.status === "ACTIVE" ? "Active" : "Disabled"}
            </span>
            <span className="ml-2 text-gray-500">
              {STORE_SCOPED.includes(member.role)
                ? "store-scoped role"
                : WAREHOUSE_SCOPED.includes(member.role)
                  ? "warehouse-scoped role"
                  : "org-wide role"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RoleControl member={member} />
          <StatusControl member={member} />
        </div>
      </div>
      {STORE_SCOPED.includes(member.role) && (
        <div className="mt-3">
          <ScopeEditor member={member} kind="store" options={stores} assigned={member.storeIds} />
        </div>
      )}
      {WAREHOUSE_SCOPED.includes(member.role) && (
        <div className="mt-3">
          <ScopeEditor member={member} kind="warehouse" options={warehouses} assigned={member.warehouseIds} />
        </div>
      )}
    </div>
  );
}

export function MembersManager({
  initialMembers,
  stores,
  warehouses,
}: {
  initialMembers: Member[];
  stores: Option[];
  warehouses: Option[];
}) {
  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {initialMembers.length === 0 ? (
        <p className="rounded border p-6 text-center text-sm text-gray-500">
          No members yet. Add your team below.
        </p>
      ) : (
        initialMembers.map((member) => (
          <MemberRow key={member.id} member={member} stores={stores} warehouses={warehouses} />
        ))
      )}

      <div className="rounded border p-3">
        {showInvite ? (
          <InviteForm onDone={() => setShowInvite(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setShowInvite(true)}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white"
          >
            + Add user
          </button>
        )}
      </div>
    </div>
  );
}
