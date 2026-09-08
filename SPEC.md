# POSPLUS — Full-Stack Application Specification

## 1. Product Definition

**POSPLUS ("Loyverse+")** is a multi-tenant, web-based back-office/ERP layer connected to an existing Loyverse POS account. POSPLUS does not replace the POS used by store staff. It imports operational data from Loyverse, performs back-office accounting, procurement, manufacturing, workforce, and analytics workflows, and selectively writes approved stock-related changes back to Loyverse through the official API.

Primary source requirements: POSPLUS must support initial synchronization of stores, categories, items/variants, employees, customers, and historical receipts; near-real-time webhook ingestion; automated finance posting; reorder suggestions; purchase orders and approvals; BOM/recipe costing and production; payroll/leave workflows; consolidated analytics; multi-store/multi-warehouse operation; and organization-scoped RBAC. fileciteturn0file0L12-L40

## 2. Goals and Non-Goals

### Goals
- Give owners/managers one back-office for multiple Loyverse stores.
- Preserve Loyverse as the store-facing POS.
- Maintain an auditable mini general ledger.
- Provide purchasing and receiving workflows with approval controls.
- Track production, yield, waste, and BOM/recipe cost.
- Derive payroll inputs from synchronized shift/clock-in data.
- Provide store-level and consolidated management reporting.
- Keep all tenant data isolated by organization.

### Non-Goals
- Do not replace the Loyverse POS UI.
- Do not scrape Loyverse or depend on undocumented endpoints.
- No mobile application in this version.
- No cross-chain integrations or unrelated payment processing.
- No mainnet-specific deployment requirement beyond what the official Loyverse integration supports.
- No silent deletion or mutation of posted accounting/payroll records.

The integration is explicitly limited to official Loyverse API and webhook mechanisms. fileciteturn0file0L37-L40

## 3. Technology Architecture

### Required stack
- Next.js: web frontend and backend/API routes.
- Node.js runtime.
- TypeScript.
- Prisma ORM.
- PostgreSQL hosted on Railway.
- Redis + BullMQ for asynchronous processing.
- Tailwind CSS.
- Auth.js / NextAuth credentials provider.
- S3-compatible object storage (Cloudflare R2, AWS S3, or compatible provider).
- `@react-pdf/renderer` or Puppeteer for PDFs.
- pnpm.
- Railway for web app, worker, PostgreSQL, and Redis.
- Optional local Docker Compose stack: PostgreSQL, Redis, MinIO.

These technology choices, including Railway deployment and a persistent worker, are part of the source brief. fileciteturn0file0L73-L103

### Dependency policy
Use the latest stable, security-supported versions available when implementation begins, subject to compatibility with the current Next.js/React/Node.js ecosystem. Do not blindly upgrade a dependency in a way that breaks Prisma, Auth.js, BullMQ, PDF generation, or deployment. Lock the resolved versions in `pnpm-lock.yaml`, run tests after upgrades, and record major-version upgrade decisions in `CHANGELOG.md`.

## 4. Repository Structure

```text
posplus/
├─ app/
│  ├─ (auth)/
│  │  ├─ login/page.tsx
│  │  └─ signup/page.tsx
│  ├─ (app)/
│  │  ├─ layout.tsx
│  │  ├─ dashboard/page.tsx
│  │  ├─ management/
│  │  │  ├─ stores/page.tsx
│  │  │  ├─ commissary/page.tsx
│  │  │  └─ components/
│  │  │     ├─ dashboard-filters.tsx
│  │  │     ├─ kpi-grid.tsx
│  │  │     ├─ inventory-health-card.tsx
│  │  │     ├─ sales-summary.tsx
│  │  │     ├─ production-summary.tsx
│  │  │     ├─ procurement-alerts.tsx
│  │  │     └─ supplier-price-trends.tsx
│  │  ├─ finance/
│  │  │  ├─ dashboard/page.tsx
│  │  │  ├─ ledger/page.tsx
│  │  │  ├─ accounts/page.tsx
│  │  │  ├─ mappings/page.tsx
│  │  │  ├─ ap/page.tsx
│  │  │  ├─ ar/page.tsx
│  │  │  └─ reports/pnl/page.tsx
│  │  ├─ supply-chain/
│  │  │  ├─ inventory/page.tsx
│  │  │  ├─ reorder/page.tsx
│  │  │  ├─ purchase-orders/page.tsx
│  │  │  ├─ purchase-orders/[id]/page.tsx
│  │  │  ├─ transfers/page.tsx
│  │  │  └─ suppliers/page.tsx
│  │  ├─ manufacturing/
│  │  │  ├─ bom/page.tsx
│  │  │  ├─ bom/[id]/page.tsx
│  │  │  ├─ production/page.tsx
│  │  │  └─ production/[id]/page.tsx
│  │  ├─ workforce/
│  │  │  ├─ employees/page.tsx
│  │  │  ├─ time/page.tsx
│  │  │  ├─ payroll/page.tsx
│  │  │  ├─ payroll/[id]/page.tsx
│  │  │  └─ leave/page.tsx
│  │  ├─ analytics/
│  │  │  ├─ executive/page.tsx
│  │  │  ├─ sales/page.tsx
│  │  │  ├─ inventory/page.tsx
│  │  │  ├─ margin/page.tsx
│  │  │  └─ labor/page.tsx
│  │  └─ settings/
│  │     ├─ organization/page.tsx
│  │     ├─ loyverse/page.tsx
│  │     ├─ stores/page.tsx
│  │     ├─ warehouses/page.tsx
│  │     ├─ roles/page.tsx
│  │     ├─ payroll-rules/page.tsx
│  │     ├─ dashboard/page.tsx
│  │     └─ audit-log/page.tsx
│  ├─ api/
│  │  ├─ auth/[...nextauth]/route.ts
│  │  ├─ loyverse/
│  │  │  ├─ connect/route.ts
│  │  │  ├─ sync/route.ts
│  │  │  └─ webhook/route.ts
│  │  ├─ finance/
│  │  │  ├─ journal-entries/route.ts
│  │  │  ├─ accounts/route.ts
│  │  │  ├─ mappings/route.ts
│  │  │  └─ exports/route.ts
│  │  ├─ purchasing/
│  │  │  ├─ purchase-orders/route.ts
│  │  │  ├─ purchase-orders/[id]/approve/route.ts
│  │  │  ├─ purchase-orders/[id]/reject/route.ts
│  │  │  ├─ purchase-orders/[id]/receive/route.ts
│  │  │  └─ transfers/route.ts
│  │  ├─ manufacturing/
│  │  │  ├─ boms/route.ts
│  │  │  ├─ boms/[id]/route.ts
│  │  │  └─ production-orders/route.ts
│  │  ├─ workforce/
│  │  │  ├─ payroll-runs/route.ts
│  │  │  ├─ payroll-runs/[id]/finalize/route.ts
│  │  │  └─ leave/route.ts
│  │  ├─ analytics/
│  │  │  ├─ executive/route.ts
│  │  │  └─ dashboard/route.ts
│  │  ├─ documents/
│  │  │  └─ [id]/download/route.ts
│  │  └─ health/route.ts
├─ components/
├─ lib/
│  ├─ auth/
│  ├─ db/
│  ├─ loyverse/
│  ├─ finance/
│  ├─ procurement/
│  ├─ manufacturing/
│  ├─ workforce/
│  ├─ analytics/
│  ├─ audit/
│  ├─ storage/
│  └─ pdf/
├─ prisma/
│  ├─ schema.prisma
│  ├─ seed.ts
│  └─ migrations/
├─ worker/
│  ├─ index.ts
│  ├─ queues/
│  └─ jobs/
├─ scripts/
├─ docker-compose.yml
├─ .env.example
├─ AGENT.md
├─ BRAND.md
├─ SPEC.md
├─ package.json
└─ pnpm-lock.yaml
```

## 5. Tenant and Authorization Model

### Organization
Every Loyverse-connected business maps to exactly one POSPLUS `Organization`. Every business-domain record must have an `organizationId` directly or through a parent relation that unambiguously establishes tenant ownership.

### Roles
- **Owner**: organization configuration, all modules, financial reporting, user/role administration, Loyverse integration.
- **Store Manager**: assigned stores, inventory, POs, transfers, production, operational analytics.
- **Accountant/Bookkeeper**: ledger, mappings, AP/AR, P&L, financial exports.
- **Warehouse Staff**: warehouse inventory, transfers, receiving, inventory adjustments where authorized.
- **HR Admin**: employees, time data, payroll, leave, labor reports.

Enforce permissions on the server even when UI elements are hidden. Never rely on client-side role checks.

### Store and warehouse scope
A role can optionally be restricted to specific stores and/or warehouses. A request is authorized only when both:
1. the record belongs to the authenticated organization, and
2. the authenticated user's role/action scope permits access to that store/warehouse.

## 6. Core Pages

### Authentication
- `/login`: credentials login, clear error state, session handling.
- `/signup`: organization owner signup.
- Post-login redirect to executive dashboard.

### Executive Dashboard
`/dashboard` and `/analytics/executive`
- Date range selector.
- Company/store filter.
- Sales.
- Gross margin.
- Inventory turnover.
- Labor cost %.
- Supplier reliability.
- Cross-store P&L snapshot.
- Alerts: failed syncs, low stock, pending approvals, payroll exceptions.
- Drill down from KPI to source records.

### Management Dashboard Modes
The main management dashboard is a **management-side overview**, not a store-clerk POS screen. It must support a primary context filter that switches between:

- **Stores**
- **Commissary**

A secondary **scope selector** may choose **All Stores / All Commissaries** or a specific store/commissary. A **period selector** must support at minimum **This Week** and **This Month**, plus custom date ranges. KPI cards and charts must recalculate for the selected context and period.

#### Global one-glance overview
For the selected period and applicable scope, show:
- **Total Purchased**
- **Total Sales**
- **Total Remaining Inventory**, including quantity and monetary value
- **Total Wastage** and **Wastage %**
- **Total Produced** where production scope applies
- **Planned vs Actual Yield** and **Yield Difference %**
- **Recent Price Change Alerts** comparing actual/recent purchase prices against the configured planned/default price
- A clearly visible **3.3× sales reference value**, calculated as `selectedSalesAmount * 3.3`, shown alongside—not instead of—the source sales amount
- Gross margin, inventory turnover, labor cost %, and supplier reliability where the selected context supports them

Every KPI must display its period, scope, unit/currency, and a drill-down action.

#### Stores dashboard
When **Stores** is selected, show:

1. **Inventory Dashboard**
   - Total stock value.
   - Low-stock item count and value.
   - Out-of-stock item count and value.
   - Stock-health status and distribution.
   - Low-stock and out-of-stock alerts.
   - Top-selling items across the selected stores.

2. **Daily Sales Summary — Stores only**
   - Total sales for the selected day.
   - Average daily sales.
   - Highest-sales day in the selected period.
   - Daily sales trend.
   - Top-selling products.
   - Optional sales-channel breakdown when available.

3. **Monthly Sales Overview — Stores only**
   - Monthly sales trend.
   - Monthly sales totals.
   - Top-selling items.
   - Store-to-store comparison.
   - Period total and average monthly sales where history permits.

4. **Stock health**
   - In Stock / Low Stock / Out of Stock counts.
   - Percentage of active SKUs in each state.
   - A clear visual status distribution inspired by the supplied inventory dashboard reference.

#### Commissary dashboard
When **Commissary** is selected, show:

1. **Inventory Dashboard**
   - Total commissary stock value.
   - Low-stock items.
   - Out-of-stock items.
   - Stock-health status.
   - Ingredient/raw-material inventory by commissary/location.

2. **Daily Production Summary — Commissary only**
   - Total produced for the selected day.
   - Production orders completed.
   - Planned yield vs actual yield.
   - Yield difference %.
   - Total waste and waste %.
   - Major production variances.

3. **Monthly Produced Overview — Commissary only**
   - Monthly produced quantity/value.
   - Production trend.
   - Planned vs actual yield by month.
   - Waste trend.
   - Top produced items/recipes.

4. **Price Change Alerts**
   - Recent actual purchase price vs default/planned price.
   - Absolute and percentage variance.
   - Ingredient and supplier.
   - Latest purchase date.
   - Severity for unusually large increases.
   - Drill-down to the purchase and supplier price history.

#### Procurement and supplier intelligence
The management dashboard must include procurement intelligence:
- Recent alerts showing actual purchase prices versus the initial/default planned price.
- After a manager checks supplier prices externally (for example by calling the supplier) and encodes the quote/current price, compare supplier prices and provide a buy recommendation.
- Recommendations should consider current price first, then lead time and supplier reliability when available.
- Trend which suppliers are consistently cheaper or more competitive for each ingredient.
- Persist supplier and purchase-price history per ingredient so managers can review how prices changed over time.
- Supplier comparison should expose latest price, historical average, recent low, and price trend for the same ingredient.

#### Dashboard interaction and design requirements
The dashboard should follow the supplied visual references as layout inspiration:
- Data-dense but clean business/ERP presentation.
- KPI cards at the top for one-glance review.
- Prominent Store/Commissary and date filters.
- Trend charts for sales, production, waste, and supplier prices.
- Tables for exact operational values.
- Status badges for stock and price/yield exceptions.
- Cross-store comparisons visible without leaving the management dashboard.
- Summary first, drill-down detail second.
- Avoid consumer-app patterns that hide operational detail.

### Loyverse Connection
`/settings/loyverse`
- Enter API key through secure server action/API.
- Never return stored key to the browser.
- Connection status.
- Last successful sync.
- Last webhook received.
- Manual "Sync now".
- Sync history and error details safe for operators.

### Finance
`/finance/dashboard`
- Cash/sales summary.
- Posted ledger summary.
- AP/AR aging.
- P&L.

`/finance/ledger`
- Journal-entry list with filtering.
- Entry detail showing source receipt/refund, posting date, account lines, debit/credit totals.
- Reversal workflow, never hard-delete posted entries.

`/finance/accounts`
- Chart of accounts.
- Account type.
- Active/inactive state.
- Store/company applicability.

`/finance/mappings`
- Map Loyverse payment types/categories to GL accounts.

`/finance/reports/pnl`
- Store-level and consolidated P&L.
- Period comparison.
- Export to PDF.

### Supply Chain
`/supply-chain/inventory`
- Inventory by store/warehouse/item/variant.
- On-hand quantity.
- Reserved quantity if implemented.
- Reorder point.
- Suggested reorder quantity.

`/supply-chain/reorder`
- Suggested reorder list.
- Reason and sales-velocity inputs.
- Accept/dismiss workflow.
- Convert accepted suggestions into PO drafts.

`/supply-chain/purchase-orders`
- PO list with Draft, Pending Approval, Approved, Rejected, Partially Received, Received, Cancelled.
- Filters by store, supplier, date, status.

`/supply-chain/purchase-orders/[id]`
- Header.
- Supplier.
- Destination warehouse/store.
- Lines and quantities.
- Approval history.
- Receiving.
- PDF.
- Stock update status.

`/supply-chain/transfers`
- Create stock transfer between warehouses.
- Track Requested → Approved → In Transit → Received.

`/supply-chain/suppliers`
- Supplier master data.
- Default lead time.
- Scorecard with on-time delivery and received-vs-ordered quantities.

### Manufacturing
`/manufacturing/bom`
- BOM/recipe list associated with Loyverse composite items.
- Ingredient/component quantities.
- Units.
- Cost rollup.
- Expected yield.
- Waste allowance.

`/manufacturing/bom/[id]`
- Detailed recipe.
- Current component costs.
- Cost per batch/unit.
- Yield and waste assumptions.

`/manufacturing/production`
- Production-order list.
- Draft → Released → In Progress → Completed → Closed/Cancelled.

`/manufacturing/production/[id]`
- Planned output.
- Actual output.
- Component consumption.
- Waste.
- Variance.
- Cost result.

### Workforce
`/workforce/employees`
- Employees synced from Loyverse.
- Employment state.
- Store assignment.
- Pay rules.

`/workforce/time`
- Shift/clock-in data from Loyverse.
- Missing punches or exceptions.
- Review before payroll.

`/workforce/payroll`
- Payroll periods.
- Draft and calculated runs.
- Approval/finalization.
- Payroll PDF/payslips.

`/workforce/leave`
- Leave requests.
- Approval/rejection.
- Balance/usage tracking.

### Settings
- Organization.
- Stores.
- Warehouses.
- Users and roles.
- Payroll rules: pay rates, pay period, statutory deduction settings.
- Audit log.

The required post-sync setup items are GL mapping, warehouses/locations, supplier lead times, payroll rules, and roles/permissions. fileciteturn0file0L28-L36

## 7. API Contract

All non-public endpoints require a valid Auth.js session and server-side authorization.

### Authentication
- `GET/POST /api/auth/[...nextauth]`

### Loyverse
- `POST /api/loyverse/connect`
  - Input: API key.
  - Action: validate credential server-side, encrypt, store encrypted credential, enqueue initial sync.
- `POST /api/loyverse/sync`
  - Input: optional sync type/full-vs-incremental.
  - Action: authorize and enqueue sync job.
- `POST /api/loyverse/webhook`
  - Public machine-to-machine endpoint.
  - Verify webhook signature/secret before parsing business events.
  - Enqueue normalized event; return quickly.
- `GET /api/loyverse/sync/status`
  - Return sanitized sync state.

The source explicitly requires sensitive API keys/secrets, verified incoming webhook payloads, and official API/webhook integration only. fileciteturn0file0L64-L71

### Finance
- `GET /api/finance/accounts`
- `POST /api/finance/accounts`
- `PATCH /api/finance/accounts/:id`
- `GET /api/finance/journal-entries`
- `GET /api/finance/journal-entries/:id`
- `POST /api/finance/journal-entries/:id/reverse`
- `GET/PUT /api/finance/mappings`
- `GET /api/finance/reports/pnl`
- `POST /api/finance/exports`

Never expose arbitrary journal-line mutation after posting.

### Procurement
- `GET/POST /api/purchasing/purchase-orders`
- `GET/PATCH /api/purchasing/purchase-orders/:id`
- `POST /api/purchasing/purchase-orders/:id/submit`
- `POST /api/purchasing/purchase-orders/:id/approve`
- `POST /api/purchasing/purchase-orders/:id/reject`
- `POST /api/purchasing/purchase-orders/:id/receive`
- `GET/POST /api/purchasing/transfers`
- `POST /api/purchasing/transfers/:id/approve`
- `POST /api/purchasing/transfers/:id/receive`

Receiving must be idempotent and must not double-write inventory to Loyverse.

### Manufacturing
- `GET/POST /api/manufacturing/boms`
- `GET/PATCH /api/manufacturing/boms/:id`
- `POST /api/manufacturing/boms/:id/publish`
- `GET/POST /api/manufacturing/production-orders`
- `GET/PATCH /api/manufacturing/production-orders/:id`
- `POST /api/manufacturing/production-orders/:id/start`
- `POST /api/manufacturing/production-orders/:id/complete`

### Workforce
- `GET /api/workforce/employees`
- `GET /api/workforce/time`
- `GET/POST /api/workforce/payroll-runs`
- `POST /api/workforce/payroll-runs/:id/calculate`
- `POST /api/workforce/payroll-runs/:id/finalize`
- `GET/POST /api/workforce/leave`
- `POST /api/workforce/leave/:id/approve`
- `POST /api/workforce/leave/:id/reject`

### Analytics
- `GET /api/analytics/executive`
- `GET /api/analytics/dashboard`
- Query: `from`, `to`, `mode=stores|commissary`, optional `storeId`, optional `commissaryId`, optional comparison period.
- Return normalized KPI values and drill-down URLs/IDs.

`GET /api/analytics/dashboard` should return mode-specific sections:

```ts
{
  scope: { mode, organizationId, storeId?, commissaryId?, from, to },
  overview: {
    totalPurchased,
    totalSales,
    remainingInventoryQuantity,
    remainingInventoryValue,
    totalWaste,
    wastePercent,
    totalProduced,
    plannedYield,
    actualYield,
    yieldDifferencePercent,
    salesReferenceMultiplier: 3.3,
    salesReferenceValue
  },
  stores?: {
    inventory,
    lowStockAlerts,
    dailySalesSummary,
    monthlySalesOverview,
    topSellingItems
  },
  commissary?: {
    inventory,
    dailyProductionSummary,
    monthlyProducedOverview,
    priceChangeAlerts,
    supplierRecommendations,
    ingredientPriceTrends
  }
}
```

Additional procurement intelligence endpoints:
- `GET /api/purchasing/price-alerts`
- `GET /api/purchasing/price-history`
- `GET /api/purchasing/supplier-comparison`
- `GET /api/purchasing/recommendations`

All analytics endpoints must enforce organization and store/commissary scope server-side.

### Documents
- `POST /api/documents/:id/generate`
- `GET /api/documents/:id/download`

Object storage should hold durable generated business documents rather than local disk. fileciteturn0file0L84-L88

## 8. Database Model

Use PostgreSQL + Prisma. Suggested core entities:

### Identity / tenancy
- `User`
  - id, email, passwordHash, name, status, createdAt, updatedAt
- `Organization`
  - id, name, currency, timezone, status, createdAt, updatedAt
- `OrganizationMembership`
  - id, organizationId, userId, role, status
- `Store`
  - id, organizationId, loyverseStoreId, name, address, timezone, active
- `Warehouse`
  - id, organizationId, storeId?, name, code, active
- `UserStoreAccess`
- `UserWarehouseAccess`

### Integration
- `LoyverseConnection`
  - id, organizationId, encryptedApiKey, keyVersion, status, lastSyncAt
- `WebhookEvent`
  - id, organizationId, externalEventId, eventType, signatureVerified, payloadHash, receivedAt, processedAt, status, error
- `SyncRun`
  - id, organizationId, type, startedAt, finishedAt, status, counts, errorSummary

### Synced master data
- `Category`
- `Item`
- `Variant`
- `Employee`
- `Customer`
- `Receipt`
- `ReceiptLine`
- `Refund`
- `RefundLine`

External Loyverse identifiers must have unique constraints within the relevant organization.

### Finance
- `GLAccount`
- `GLMapping`
- `JournalEntry`
- `JournalLine`
- `FiscalPeriod`
- `ARInvoice`
- `APBill`
- `Payment`
- `LedgerSourceLink`

Accounting invariant:
- Every posted journal entry has at least one debit and one credit.
- Sum(debits) == Sum(credits) exactly in decimal arithmetic.
- Posted entries have immutable accounting lines.
- Reversals create new entries linked to the original.

### Inventory / procurement
- `InventoryBalance`
- `InventoryMovement`
- `ReorderSuggestion`
- `Supplier`
- `SupplierScorecardSnapshot`
- `SupplierIngredientPrice`
- `IngredientPriceHistory`
- `PriceChangeAlert`
- `SupplierPriceRecommendation`
- `PurchaseOrder`
- `PurchaseOrderLine`
- `PurchaseOrderApproval`
- `GoodsReceipt`
- `GoodsReceiptLine`
- `StockTransfer`
- `StockTransferLine`

### Manufacturing
- `BOM`
- `BOMLine`
- `ProductionOrder`
- `ProductionConsumption`
- `ProductionOutput`
- `ProductionWaste`
- `UnitOfMeasure`

### Workforce
- `EmployeePayRule`
- `Shift`
- `PayrollPeriod`
- `PayrollRun`
- `PayrollLine`
- `LeaveRequest`
- `LeaveBalance`
- `StatutoryDeductionRule`

### Dashboard / operational dimensions
- `Commissary`
- `DashboardPreference`
- `DashboardMetricSnapshot` (recommended for expensive period aggregates)
- `PriceAlertRule` (recommended)
- `SalesReferenceRule` for configurable management multipliers; seed the initial rule at `3.3`.

A `Commissary` belongs to an organization and has its own inventory scope. Stores and commissaries remain distinct operational scopes, while company-level dashboards can aggregate them when a metric is applicable.

`SupplierIngredientPrice` / `IngredientPriceHistory` must preserve immutable purchase-price history rather than overwriting prior unit prices. Each price record should link to the underlying supplier and purchase/receipt record when available.

### Cross-cutting
- `AuditLog`
- `Document`
- `OutboxEvent` (recommended)
- `IdempotencyKey` (recommended)

## 9. Synchronization Design

### Initial sync
Sequence:
1. Validate Loyverse credential.
2. Create `SyncRun`.
3. Sync stores.
4. Sync categories.
5. Sync items and variants.
6. Sync employees.
7. Sync customers.
8. Sync historical receipts/refunds.
9. Normalize and persist records.
10. Mark sync complete.
11. Trigger post-sync setup checklist.

This ordering mirrors the source's initial-sync flow. fileciteturn0file0L12-L19

Implement pagination, retries with exponential backoff, rate-limit handling, and resumability. Do not run all pages inside an HTTP request; use BullMQ.

### Webhook flow
```text
Loyverse webhook
    ↓
POST /api/loyverse/webhook
    ↓
verify signature/secret
    ↓
validate schema + required event ID
    ↓
store immutable webhook event
    ↓
enqueue BullMQ job
    ↓
worker normalizes event
    ↓
upsert source record idempotently
    ↓
trigger domain side effects
    ↓
audit result
```

Receipt/refund events should update the local read model and enqueue finance posting. Inventory changes should update the inventory projection and trigger relevant analytics/reorder work. Item/customer updates update local master-data projections.

## 10. Queue and Background Jobs

Use Redis + BullMQ.

Queues:
- `loyverse-webhooks`
- `loyverse-sync`
- `finance-posting`
- `inventory`
- `reorder`
- `payroll`
- `documents`
- `analytics`

Jobs:
- `process-loyverse-webhook`
- `initial-loyverse-sync`
- `incremental-loyverse-sync`
- `post-receipt-to-ledger`
- `post-refund-to-ledger`
- `recalculate-reorder-points`
- `generate-recurring-report`
- `calculate-payroll`
- `generate-po-pdf`
- `generate-payslip-pdf`
- `generate-pnl-pdf`
- `supplier-scorecard-refresh`
- `refresh-dashboard-metric-snapshots`
- `detect-price-change-alerts`
- `refresh-supplier-price-recommendations`
- `refresh-ingredient-price-trends`

The source specifically calls for Redis/BullMQ for webhook ingestion, nightly reorder calculations, and payroll batch runs. fileciteturn0file0L80-L82

### Scheduling
Run nightly:
- reorder-point recalculation
- supplier scorecard snapshots
- recurring reports
- reconciliation checks
- stale webhook/sync failure checks
- dashboard aggregate refresh where query cost justifies snapshots
- supplier ingredient price trend refresh
- price-change alert detection/re-evaluation

Price alerts and supplier recommendations should also refresh immediately after a goods receipt or purchase price is encoded so the management dashboard reflects the latest supplier information without waiting for the nightly batch.

Use Railway cron or a controlled Node scheduler according to the deployment environment. fileciteturn0file0L87-L93

## 11. Finance Rules

### Auto-post sales
On a completed receipt, create a balanced journal entry from configured mappings. Preserve source linkage to:
- organization
- store
- Loyverse receipt ID
- payment type
- receipt total
- posting timestamp

### Auto-post refunds
Refund postings must reverse the relevant revenue/receivable/cash impacts based on the configured mapping. Never delete the original receipt posting.

### P&L
At minimum, report:
- sales/revenue
- refunds/contra-revenue
- cost of goods sold where cost data exists
- gross profit
- operating expense categories when configured
- net result

When cost data is incomplete, label the KPI rather than presenting an implied false precision.

## 12. Reorder-Point Logic

The first implementation can use sales velocity plus supplier lead time.

Example:
```text
averageDailySales = unitsSold / lookbackDays
demandDuringLeadTime = averageDailySales * leadTimeDays
safetyStock = averageDailySales * safetyStockDays
reorderPoint = demandDuringLeadTime + safetyStock

suggestedOrderQty =
  max(0, targetStock - onHand - onOrder)
```

The UI must show the inputs used for each suggestion so managers can understand the recommendation. The nightly job recalculates suggestions.

## 13. Purchase Order Workflow

```text
Draft
  ↓ submit
Pending Approval
  ↓ approve                    ↘ reject
Approved                        Rejected
  ↓
Partially Received
  ↓
Received
  ↓
Closed
```

A receipt of goods:
1. validates the PO state and line quantities,
2. creates a `GoodsReceipt`,
3. creates immutable `InventoryMovement` records,
4. updates local inventory,
5. writes the appropriate stock count back to Loyverse through the official API,
6. records external request/response metadata without storing secrets,
7. marks synchronization status,
8. logs the actor and timestamp.

This directly implements the requested create → approve → receive → auto stock update flow. fileciteturn0file0L54-L60

## 14. Manufacturing Rules

For a BOM/recipe:
- components may be items/variants or internal raw materials;
- each line includes quantity and unit;
- cost is derived from the latest applicable unit cost;
- batch cost = sum(component quantity × component unit cost);
- expected unit cost = batch cost / expected yield;
- actual production records output and waste separately.

Variance report:
```text
planned component qty vs actual component qty
planned yield vs actual yield
planned waste vs actual waste
planned cost vs actual cost
```

Composite/recipe items must remain linked to the corresponding Loyverse item/variant where applicable. fileciteturn0file0L45-L46

## 15. Workforce and Payroll

Input:
- synced employees
- synced shifts/clock-ins
- pay rules
- pay period
- statutory deductions configuration
- approved leave

Payroll run states:
`Draft → Calculating → Review → Approved/Finalized`

A finalized payroll run is append-only. Corrections must be represented as adjustment/reversal records, not destructive edits.

Labor KPI:
```text
laborCostPercent = payrollLaborCost / netSales * 100
```

The UI should disclose the period and store scope used for the calculation.

## 16. Analytics

Executive analytics remains the consolidated cross-store/company view required by the base specification, while the management dashboard adds explicit **Stores** and **Commissary** modes.

### Required universal dashboard KPIs
For a selected period and scope, calculate and expose:
- Total purchased.
- Total sales.
- Remaining inventory quantity.
- Remaining inventory value.
- Total wastage.
- Wastage %.
- Total produced where production scope applies.
- Planned yield.
- Actual yield.
- Yield difference %.
- Sales × 3.3 reference value.
- Gross margin.
- Inventory turnover.
- Labor cost %.
- Supplier reliability.

### Store-mode analytics
Store mode must expose:
- Inventory value and stock health.
- Low-stock alerts.
- Out-of-stock alerts.
- Daily sales summary.
- Monthly sales overview.
- Top-selling items across the selected store set.
- Optional store comparison.

### Commissary-mode analytics
Commissary mode must expose:
- Ingredient/raw-material inventory value and health.
- Daily production summary.
- Monthly produced overview.
- Planned vs actual yields.
- Yield variance %.
- Waste amount and waste %.
- Price change alerts.

### Procurement intelligence
The analytics layer must retain and analyze purchase price history **per ingredient and per supplier**. At minimum:
- latest purchased unit price;
- prior purchased unit price;
- default/planned unit price;
- absolute variance;
- percentage variance;
- historical average;
- lowest recent supplier price;
- supplier ranking for an ingredient;
- price trend over time.

A price-change alert is generated when the latest actual purchase price differs from the configured planned/default price by a configurable threshold. The raw variance must remain visible even when it does not exceed the alert threshold.

Supplier purchase recommendations are decision-support only. They should compare currently encoded supplier prices, historical prices, lead time, and supplier reliability when available. The system must not place an order automatically.

### Metric definitions
- **Inventory turnover** = COGS / average inventory value for the selected period where cost basis is available.
- **Gross margin %** = gross profit / net sales × 100.
- **Supplier reliability** = configurable on-time delivery and quantity-accuracy score.
- **Labor cost %** = labor cost / net sales × 100.
- **Wastage %** = waste quantity (or waste value, depending on the report) divided by the configured production basis. The UI must state the denominator.
- **Yield difference %** = `(actualYield - plannedYield) / plannedYield * 100`.
- **3.3× reference value** = `selectedSalesAmount * 3.3`. Display this beside the source sales amount; do not replace the source amount.

Filters:
- period: This Week, This Month, custom range;
- store / all stores;
- commissary / all commissaries;
- optional warehouse;
- comparison period.

The source explicitly requires a consolidated cross-store dashboard and store/company slicing. fileciteturn0file0L49-L60

Every KPI card must show its scope and period and have a "View details" path to source records.

## 17. Auditability

Audit:
- login/logout/security events where relevant
- organization and role changes
- integration credential changes
- sync runs
- webhook verification outcome
- PO creation/approval/rejection/receiving
- inventory adjustments
- BOM publish/change
- production completion
- payroll calculation/finalization
- journal posting/reversal
- document generation

Audit record:
```text
id
organizationId
actorUserId
action
entityType
entityId
beforeJson?
afterJson?
metadataJson?
ipAddress?
userAgent?
createdAt
```

Posted financial and payroll records must not support hard-delete operations. The source requires append-only/auditable treatment. fileciteturn0file0L69-L71

## 18. Security Requirements

### Secrets
- Encrypt Loyverse API keys at rest using a server-side encryption key.
- Encrypt or protect webhook secrets according to provider expectations.
- Never log credentials.
- Never return the plaintext credential after storage.
- Keep encryption keys in deployment secrets, not the database.
- Rotate encryption keys using a versioned-key approach.

### Webhooks
- Verify signature/secret before business processing.
- Reject malformed or replayed requests.
- Store a hash / event ID for idempotency.
- Return quickly after validation and enqueueing.
- Do not trust tenant identifiers supplied by an unauthenticated body.

### API security
- Validate every request with a server-side schema validator.
- Enforce organization scope in every query.
- Apply RBAC and store/warehouse scope.
- Use parameterized Prisma queries; never build raw SQL from user input.
- Rate-limit authentication and public webhook endpoints appropriately.
- Use CSRF-safe Auth.js patterns.
- Set secure cookies and secure headers in production.

### Financial integrity
- Use database transactions for ledger posting, receiving, payroll finalization, and other multi-record state transitions.
- Use decimal database types for money and quantities where precision matters.
- Reject unbalanced journal entries.
- Make external write-backs idempotent.
- Use explicit state machines instead of arbitrary status updates.

## 19. Error Handling

Every API response follows a consistent structure:

```json
{
  "ok": false,
  "error": {
    "code": "PURCHASE_ORDER_INVALID_STATE",
    "message": "Purchase order cannot be received in its current state.",
    "details": {}
  },
  "requestId": "..."
}
```

Do not leak stack traces, secrets, provider credentials, SQL, or internal infrastructure details to clients.

Worker failures:
- retry transient provider/network errors;
- dead-letter permanently failing jobs;
- preserve the error in a safe operator-facing field;
- expose retry controls to authorized admins.

## 20. PDF and Object Storage

Documents:
- Purchase Order PDF.
- Payslip PDF.
- P&L / financial report PDF.

Generate server-side and upload to S3-compatible storage. Store:
- document ID
- organization ID
- entity reference
- storage key
- content type
- checksum
- createdAt
- generation status

Never expose raw storage credentials to the browser. Use authenticated application download endpoints or time-limited signed URLs generated server-side.

## 21. Seed Data

`prisma/seed.ts` must create a development/admin account and a minimal test organization. Credentials must come from environment variables, never hardcoded production secrets.

Example:
```text
SEED_ADMIN_EMAIL
SEED_ADMIN_PASSWORD
SEED_ORG_NAME
```

The seed should also create:
- role membership
- example store
- example warehouse
- chart of accounts
- baseline GL mappings
- example supplier
- example payroll rule

## 22. Environment Variables

`.env.example`:

```env
DATABASE_URL=
REDIS_URL=

AUTH_SECRET=
AUTH_URL=

ENCRYPTION_KEY=
KEY_VERSION=

S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

LOYVERSE_WEBHOOK_SECRET=

SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
SEED_ORG_NAME=

APP_URL=
```

Actual environment variable names may be adapted to deployment conventions, but secret values must never be committed.

## 23. Docker Development

Optional `docker-compose.yml` services:
- `postgres`
- `redis`
- `minio`
- `minio-init` if useful

The source explicitly allows Docker Compose for local Postgres, Redis, and an S3-compatible test store such as MinIO. fileciteturn0file0L100-L103

## 24. Observability

Track:
- HTTP request duration/status
- worker job duration/retries/failures
- Loyverse API failures/rate limiting
- webhook processing lag
- sync duration and records processed
- ledger posting failures
- payroll calculation failures
- PDF generation failures

Include a request/job correlation ID in logs.

Do not log full webhook bodies when they may contain sensitive business or customer information. Prefer event IDs and sanitized metadata.

## 25. Testing Strategy

### Unit tests
- ledger balancing
- reorder calculations
- BOM costing
- payroll calculations
- permissions
- state-transition validators
- webhook signature validation
- idempotency logic

### Integration tests
- Prisma transactions
- webhook ingestion → queue → persistence
- receipt → journal posting
- PO → approval → receiving → inventory write-back
- payroll run calculation/finalization
- PDF generation and object storage adapter

### End-to-end tests
1. Sign up and connect Loyverse.
2. Initial sync.
3. View executive dashboard.
4. Configure GL mappings.
5. Create and approve PO.
6. Receive PO and verify stock update request.
7. Create BOM and production order.
8. Sync shifts and run payroll.
9. Submit and approve leave.
10. Export P&L.

## 26. Demo Scenario

A complete demo should cover:
1. Sign up and connect Loyverse.
2. Initial sync.
3. Configure GL mapping and warehouses.
4. Review low-stock reorder suggestion.
5. Create PO.
6. Approve PO.
7. Receive PO.
8. Verify stock write-back.
9. Encode an actual supplier purchase price.
10. Show a planned-vs-actual price-change alert.
11. Compare supplier prices for the same ingredient.
12. View ingredient price history and a buy recommendation.
13. Create BOM and production order.
14. Complete production and record waste.
15. View planned vs actual yield and yield difference %.
16. Run payroll from synced shifts.
17. Approve a leave request.
18. View consolidated P&L.
19. Open **Stores** dashboard for This Week.
20. Verify total sales, 3.3× reference value, remaining inventory value, low/out-of-stock alerts, daily sales summary, monthly sales overview, and top-selling items.
21. Open **Commissary** dashboard for This Month.
22. Verify production totals, planned vs actual yield, waste %, inventory value, and price alerts.

## 27. Definition of Done

The implementation is acceptable when:
- all major pages are reachable and role-gated;
- organizations cannot read one another's records;
- initial Loyverse sync works through background jobs;
- webhook verification and idempotency work;
- receipt/refund events create balanced, auditable ledger entries;
- reorder suggestions are generated nightly;
- PO workflow supports approval and receiving;
- receiving creates local inventory movements and an official Loyverse write-back request;
- BOM costing and production tracking work;
- payroll can be calculated and finalized from synced shift data;
- leave approval works;
- executive KPIs aggregate across stores;
- Stores and Commissary management dashboard modes work with This Week / This Month / custom periods;
- store dashboard shows inventory health, low/out-of-stock alerts, daily sales, monthly sales, and top-selling items;
- commissary dashboard shows inventory, daily production, monthly production, yield variance, waste %, and price alerts;
- supplier ingredient price history is preserved and queryable;
- supplier price comparisons and purchase recommendations work from encoded current/historical prices;
- the 3.3× sales reference metric is visible beside the selected sales figure;

- PDFs are generated and stored in S3-compatible storage;
- audit logs exist for critical actions;
- financial and payroll posted records cannot be hard-deleted;
- test suite covers the critical invariants;
- production secrets are externalized;
- deployment separates web, worker, Postgres, and Redis services as required.

