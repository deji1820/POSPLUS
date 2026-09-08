import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Log in</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Credentials login lands with issue #3 (Auth.js).
      </p>
      <Link href="/dashboard" className="text-sm underline">
        Continue to dashboard (placeholder)
      </Link>
    </main>
  );
}
