/**
 * Purchase Order PDF (SPEC.md §20, issue #32).
 * Pure presentational component — data is loaded and org-scoped upstream in
 * lib/documents, so this file never touches Prisma.
 */
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { dateLabel, money } from "@/lib/pdf/format";

export interface PoPdfLine {
  /** "Item name — variant" ready-to-print label. */
  label: string;
  sku: string | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

export interface PoPdfData {
  organizationName: string;
  number: string;
  status: string;
  supplierName: string;
  supplierContact: string | null;
  warehouseName: string;
  currency: string;
  submittedAt: string | null;
  approvedAt: string | null;
  lines: PoPdfLine[];
  subtotal: string;
  total: string;
  generatedAt: string;
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  muted: { color: "#555", marginBottom: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  box: { width: "48%" },
  boxTitle: { fontSize: 8, color: "#666", textTransform: "uppercase", marginBottom: 3 },
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
  tableRow: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderColor: "#ddd" },
  colItem: { width: "44%" },
  colSku: { width: "16%" },
  colQty: { width: "12%", textAlign: "right" },
  colPrice: { width: "14%", textAlign: "right" },
  colTotal: { width: "14%", textAlign: "right" },
  totals: { marginTop: 8, alignItems: "flex-end" },
  totalLine: { flexDirection: "row", marginTop: 3 },
  totalLabel: { width: 100, color: "#555" },
  grand: { fontFamily: "Helvetica-Bold", fontSize: 12 },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, fontSize: 8, color: "#888" },
});

export function PoPdf({ data }: { data: PoPdfData }) {
  return (
    <Document title={`PO ${data.number}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Purchase Order {data.number}</Text>
        <Text style={styles.muted}>
          {data.organizationName} · status: {data.status}
        </Text>

        <View style={styles.row}>
          <View style={styles.box}>
            <Text style={styles.boxTitle}>Supplier</Text>
            <Text>{data.supplierName}</Text>
            {data.supplierContact && <Text>{data.supplierContact}</Text>}
          </View>
          <View style={styles.box}>
            <Text style={styles.boxTitle}>Deliver to</Text>
            <Text>{data.warehouseName}</Text>
            <Text>Submitted: {dateLabel(data.submittedAt)}</Text>
            <Text>Approved: {dateLabel(data.approvedAt)}</Text>
          </View>
        </View>

        <View style={styles.tableHead}>
          <Text style={styles.colItem}>Item</Text>
          <Text style={styles.colSku}>SKU</Text>
          <Text style={styles.colQty}>Qty</Text>
          <Text style={styles.colPrice}>Unit price</Text>
          <Text style={styles.colTotal}>Total</Text>
        </View>
        {data.lines.map((line, i) => (
          <View key={i} style={styles.tableRow}>
            <Text style={styles.colItem}>{line.label}</Text>
            <Text style={styles.colSku}>{line.sku ?? "—"}</Text>
            <Text style={styles.colQty}>{line.quantity}</Text>
            <Text style={styles.colPrice}>{money(line.unitPrice, data.currency)}</Text>
            <Text style={styles.colTotal}>{money(line.lineTotal, data.currency)}</Text>
          </View>
        ))}

        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text>{money(data.subtotal, data.currency)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text style={[styles.totalLabel, styles.grand]}>Total</Text>
            <Text style={styles.grand}>{money(data.total, data.currency)}</Text>
          </View>
        </View>

        <Text style={styles.footer} fixed>
          Generated {dateLabel(data.generatedAt)} by POSPLUS · PO {data.number}
        </Text>
      </Page>
    </Document>
  );
}
