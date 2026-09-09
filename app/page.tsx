import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">POSPLUS</h1>
      <p className="text-center text-gray-600 dark:text-gray-400">
        Multi-tenant back-office/ERP layer for Loyverse POS.
      </p>
      <nav className="flex gap-4 text-sm underline">
        <Link href="/login">Log in</Link>
        <Link href="/signup">Sign up</Link>
        <Link href="/dashboard">Dashboard</Link>
      </nav>
    </main>
  );
}
