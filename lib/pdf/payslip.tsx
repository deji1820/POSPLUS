/**
 * Payslip PDF (SPEC.md §20, issue #32) — one PayrollLine (employee × run)
 * rendered as a single-page payslip. Purely presentational; data is loaded
 * and org-scoped upstream in lib/documents.
 */
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { dateLabel, money } from "@/lib/pdf/format";

export interface PayslipPdfData {
  organizationName: string;
  employeeName: string;
  employeeEmail: string | null;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  regularHours: string;
  overtimeHours: string;
  gross: string;
  deductions: string;
  net: string;
  adjustmentsNote: string | null;
  runStatus: string;
  generatedAt: string;
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  muted: { color: "#555", marginBottom: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  box: { width: "48%" },
  boxTitle: { fontSize: 8, color: "#666", textTransform: "uppercase", marginBottom: 3 },
  line: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderColor: "#ddd" },
  label: { width: "60%", color: "#333" },
  value: { width: "40%", textAlign: "right" },
  grand: { fontFamily: "Helvetica-Bold", fontSize: 12, borderBottomWidth: 0 },
  netRow: { marginTop: 6, paddingVertical: 6, backgroundColor: "#f3f3f3", paddingHorizontal: 4 },
  note: { marginTop: 10, fontSize: 8, color: "#666" },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, fontSize: 8, color: "#888" },
});

export function PayslipPdf({ data }: { data: PayslipPdfData }) {
  return (
    <Document title={`Payslip — ${data.employeeName} — ${data.periodName}`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Payslip</Text>
        <Text style={styles.muted}>
          {data.organizationName} · {data.periodName} ({dateLabel(data.periodStart)} –{" "}
          {dateLabel(data.periodEnd)}) · run status: {data.runStatus}
        </Text>

        <View style={styles.row}>
          <View style={styles.box}>
            <Text style={styles.boxTitle}>Employee</Text>
            <Text>{data.employeeName}</Text>
            {data.employeeEmail && <Text>{data.employeeEmail}</Text>}
          </View>
        </View>

        <View style={styles.line}>
          <Text style={styles.label}>Regular hours</Text>
          <Text style={styles.value}>{data.regularHours}</Text>
        </View>
        <View style={styles.line}>
          <Text style={styles.label}>Overtime hours</Text>
          <Text style={styles.value}>{data.overtimeHours}</Text>
        </View>
        <View style={styles.line}>
          <Text style={styles.label}>Gross pay</Text>
          <Text style={styles.value}>{money(data.gross, data.currency)}</Text>
        </View>
        <View style={styles.line}>
          <Text style={styles.label}>Statutory deductions</Text>
          <Text style={styles.value}>-{money(data.deductions, data.currency)}</Text>
        </View>
        <View style={[styles.line, styles.netRow]}>
          <Text style={[styles.label, styles.grand]}>Net pay</Text>
          <Text style={[styles.value, styles.grand]}>{money(data.net, data.currency)}</Text>
        </View>

        {data.adjustmentsNote && <Text style={styles.note}>Adjustments: {data.adjustmentsNote}</Text>}

        <Text style={styles.footer} fixed>
          Generated {dateLabel(data.generatedAt)} by POSPLUS · this payslip was generated from
          payroll run data and is not a tax document.
        </Text>
      </Page>
    </Document>
  );
}
