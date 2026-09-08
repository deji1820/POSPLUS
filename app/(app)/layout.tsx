import type { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-7xl p-6">
      <header className="mb-6 border-b pb-4">
        <span className="text-lg font-semibold">POSPLUS</span>
      </header>
      {children}
    </div>
  );
}
