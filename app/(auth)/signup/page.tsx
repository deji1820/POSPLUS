"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signup, type SignupState } from "./actions";

const initialState: SignupState = { ok: false };

function fieldError(state: SignupState, field: string): string | undefined {
  return state.fieldErrors?.[field]?.[0];
}

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signup, initialState);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Sign up</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Create your organization. You will be its Owner (SPEC.md §5).
      </p>
      {state.message && (
        <p className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800" role="alert">
          {state.message}
        </p>
      )}
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Organization name
          <input name="organizationName" required className="rounded border p-2" />
          {fieldError(state, "organizationName") && (
            <span className="text-xs text-red-700">{fieldError(state, "organizationName")}</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Your name
          <input name="name" required autoComplete="name" className="rounded border p-2" />
          {fieldError(state, "name") && (
            <span className="text-xs text-red-700">{fieldError(state, "name")}</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded border p-2"
          />
          {fieldError(state, "email") && (
            <span className="text-xs text-red-700">{fieldError(state, "email")}</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="rounded border p-2"
          />
          {fieldError(state, "password") ? (
            <span className="text-xs text-red-700">{fieldError(state, "password")}</span>
          ) : (
            <span className="text-xs text-gray-500">At least 8 characters.</span>
          )}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 p-2 text-white disabled:opacity-50"
        >
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Log in
        </Link>
      </p>
    </main>
  );
}
