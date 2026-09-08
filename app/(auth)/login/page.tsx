"use client";

import Link from "next/link";
import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";

import { login, type LoginState } from "./actions";

const initialState: LoginState = { ok: false };

function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);
  const searchParams = useSearchParams();
  const registered = searchParams.get("registered") === "1";

  return (
    <>
      {registered && (
        <p className="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800">
          Account created — log in to continue.
        </p>
      )}
      {state.message && (
        <p className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800" role="alert">
          {state.message}
        </p>
      )}
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded border p-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="rounded border p-2"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-gray-900 p-2 text-white disabled:opacity-50"
        >
          {pending ? "Logging in…" : "Log in"}
        </button>
      </form>
    </>
  );
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Log in</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="text-sm">
        No account?{" "}
        <Link href="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
