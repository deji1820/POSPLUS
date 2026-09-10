/**
 * Shared formatting for generated PDFs (SPEC.md §20, issue #32).
 * All money is rendered from Prisma Decimal-shaped string input — never
 * floats — so totals on paper match the ledger to the cent.
 */

/** "1234.5" / "USD" → "1,234.50" (currency-less when no code is known). */
export function money(amount: string | number | null | undefined, currency?: string): string {
  const value = Number(amount ?? 0);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
  return currency ? `${currency} ${formatted}` : formatted;
}

/** ISO date/datetime → "Sep 8, 2026" (or with time when the input has one). */
export function dateLabel(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const hasTime = typeof iso === "string" && (iso.includes("T") || iso.includes(" "));
  return new Intl.DateTimeFormat("en-US", hasTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }
  ).format(d);
}
