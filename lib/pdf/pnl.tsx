/**
 * P&L / financial report PDF (SPEC.md §20, issue #32) — renders the #13
 * PnlReport read model exactly as the on-screen statement does: source-aware
 * revenue buckets, incomplete-cost labeling instead of implied precision
 * (§11), and an optional comparison column. Purely presentational.
 */
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import type { PnlAccountRow, PnlPeriod } from "@/lib/finance/pnl";
import { dateLabel, money } from "@/lib/pdf/format";

export interface PnlPdfData {
  organizationName: string;
  /** "Consolidated" or the store name the report was scoped to. */
  scopeLabel: string;
  currency: string;
  period: PnlPeriod;
  comparison: PnlPeriod | null;
  /** Incomplete-cost labeling copy straight from the read model (§11). */
  costLabel: string;
  generatedAt: string;
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  muted: { color: "#555", marginBottom: 14 },
  tableHead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#999",
    paddingBottom: 3,
    marginBottom: 3,
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    textTransform: "uppercase",
    color: "#444",
  },
  row: { flexDirection: "row", paddingVertical: 2.5 },
  rowAlt: { backgroundColor: "#f7f7f7" },
  section: { flexDirection: "row", paddingVertical: 4, marginTop: 4, borderTopWidth: 0.75, borderColor: "#aaa", fontFamily: "Helvetica-Bold" },
  label: { width: "52%" },
  amount: { width: "24%", textAlign: "right" },
  compare: { width: "24%", textAlign: "right", color: "#555" },
  grand: { fontSize: 11 },
  badge: { fontSize: 8, color: "#8a5a00", marginTop: 2 },
  note: { marginTop: 12, fontSize: 8, color: "#666" },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, fontSize: 8, color: "#888" },
});

/** Accounting-style negatives: (USD 1,234.50). */
function signed(amount: string, currency: string): string {
  const value = Number(amount);
  const formatted = money(Math.abs(value).toFixed(2), currency);
  return value < 0 ? `(${formatted})` : formatted;
}

function Amount({ amount, currency }: { amount: string | null; currency: string }) {
  return <Text style={styles.amount}>{amount === null ? "—" : signed(amount, currency)}</Text>;
}

function ExpenseRows({ rows, currency }: { rows: PnlAccountRow[]; currency: string }) {
  if (rows.length === 0) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>Operating expenses</Text>
        <Text style={styles.amount}>{money("0", currency)}</Text>
      </View>
    );
  }
  return (
    <>
      {rows.map((r, i) => (
        <View key={r.accountId} style={[styles.row, ...(i % 2 === 1 ? [styles.rowAlt] : [])]}>
          <Text style={styles.label}>
            {r.code} {r.name}
          </Text>
          <Amount amount={r.amount} currency={currency} />
        </View>
      ))}
    </>
  );
}

export function PnlPdf({ data }: { data: PnlPdfData }) {
  const { period, comparison: cmp, currency } = data;
  return (
    <Document title={`P&L — ${data.scopeLabel} — ${dateLabel(period.from)} – ${dateLabel(period.to)}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Profit &amp; Loss</Text>
        <Text style={styles.muted}>
          {data.organizationName} · {data.scopeLabel} · {dateLabel(period.from)} –{" "}
          {dateLabel(period.to)}
          {cmp ? ` · compared with ${dateLabel(cmp.from)} – ${dateLabel(cmp.to)}` : ""}
        </Text>

        <View style={styles.tableHead}>
          <Text style={styles.label}>Line</Text>
          <Text style={styles.amount}>This period</Text>
          {cmp && <Text style={styles.compare}>Previous</Text>}
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>Sales</Text>
          <Amount amount={period.sales} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.sales, currency)}</Text>}
        </View>
        <View style={[styles.row, styles.rowAlt]}>
          <Text style={styles.label}>Refunds (contra-revenue)</Text>
          <Amount amount={period.refunds} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.refunds, currency)}</Text>}
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Adjustments</Text>
          <Amount amount={period.adjustments} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.adjustments, currency)}</Text>}
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>Net revenue</Text>
          <Amount amount={period.netRevenue} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.netRevenue, currency)}</Text>}
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>Cost of goods sold</Text>
          <Amount amount={period.cogs} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.cogs, currency)}</Text>}
        </View>
        <View style={styles.section}>
          <Text style={styles.label}>
            Gross profit{!period.costDataComplete ? " (cost data unavailable)" : ""}
          </Text>
          <Amount amount={period.grossProfit} currency={currency} />
          {cmp && <Text style={styles.compare}>{cmp.grossProfit === null ? "—" : signed(cmp.grossProfit, currency)}</Text>}
        </View>

        <ExpenseRows rows={period.operatingExpenses} currency={currency} />
        <View style={styles.section}>
          <Text style={styles.label}>Total operating expenses</Text>
          <Amount amount={period.totalOperatingExpenses} currency={currency} />
          {cmp && <Text style={styles.compare}>{signed(cmp.totalOperatingExpenses, currency)}</Text>}
        </View>

        <View style={[styles.section, styles.grand]}>
          <Text style={styles.label}>Net result{!period.costDataComplete ? " (unavailable)" : ""}</Text>
          <Amount amount={period.netResult} currency={currency} />
          {cmp && <Text style={styles.compare}>{cmp.netResult === null ? "—" : signed(cmp.netResult, currency)}</Text>}
        </View>

        {!period.balances && (
          <Text style={styles.badge}>
            Note: revenue buckets do not reconcile to posted journal lines for this period.
          </Text>
        )}
        {period.costDataComplete && !cmp?.costDataComplete && cmp && (
          <Text style={styles.badge}>Note: previous period cost data is incomplete.</Text>
        )}

        <Text style={styles.note}>
          Computed from POSTED journal lines only (SPEC §11). {data.costLabel}.
        </Text>

        <Text style={styles.footer} fixed>
          Generated {dateLabel(data.generatedAt)} by POSPLUS · not a tax filing document
        </Text>
      </Page>
    </Document>
  );
}
