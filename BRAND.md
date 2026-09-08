# POSPLUS — Brand & Design Guide

## 1. Brand Direction

POSPLUS is a **business-facing back-office / ERP dashboard**, not a consumer POS replacement.

The interface should feel:
- clean
- operational
- trustworthy
- data-dense
- professional
- calm under heavy information load
- consistent across finance, inventory, procurement, manufacturing, workforce, and analytics

Avoid:
- consumer-app card grids everywhere
- oversized hero sections
- excessive gradients
- playful illustrations
- decorative animations
- oversized typography that reduces information density
- dashboard widgets with no drill-down path

## 2. Visual Principles

### Information first
Users open POSPLUS to make decisions and complete operational work. Tables, filters, totals, statuses, and action affordances take priority over decoration.

### Dense but scannable
Use compact table rows, clear column alignment, sticky table headers for long datasets, and strong grouping.

### Hierarchy
Use three primary hierarchy levels:
1. Page title / module context.
2. Section title / KPI group.
3. Row-level values and metadata.

### Consistency
Every module should use the same patterns for:
- page headers
- filters
- search
- tables
- status badges
- forms
- confirmation dialogs
- approval actions
- empty states
- loading states
- errors
- pagination

## 3. Layout

### Global application shell
```text
┌─────────────────────────────────────────────────────────────┐
│ POSPLUS | Org / Store switcher | Search | Alerts | User    │
├───────────────┬─────────────────────────────────────────────┤
│ Dashboard     │                                             │
│ Finance       │  Page title                                 │
│ Supply Chain  │  Context / filters / actions                │
│ Manufacturing │                                             │
│ Workforce     │  Main content                               │
│ Analytics     │                                             │
│ Settings      │                                             │
└───────────────┴─────────────────────────────────────────────┘
```

Desktop-first. The product is a business back office, so optimize for laptop/desktop workflows while maintaining usable responsive behavior.

## 4. Navigation

Primary navigation:
- Dashboard
- Finance
- Supply Chain
- Manufacturing
- Workforce
- Analytics
- Settings

Secondary module navigation should use tabs or grouped side navigation.

Show permission-aware navigation but keep authorization server-side.

## 5. Typography

Use a highly legible UI sans-serif. Favor a modern system-friendly stack or a production font already approved by the project.

Recommended scale:
- App title: 20–24px
- Page title: 24–30px
- Section heading: 16–20px
- Body: 13–15px
- Dense table: 12–14px
- Caption/meta: 11–12px

Avoid giant text.

Numbers should use tabular numerals where possible so columns line up visually.

## 6. Color System

Keep the palette restrained.

Base:
- neutral page background
- white/surface panels
- dark neutral text
- muted neutral borders
- subdued secondary text

Semantic states:
- success: restrained green
- warning: amber
- danger: red
- information: blue

Do not use color as the only indicator. Pair state colors with labels/icons.

For finance:
- positive/approved values can use a subtle positive semantic treatment;
- losses, overdue items, and failures use danger treatment;
- avoid coloring entire tables.

## 7. Components

### Buttons
Primary:
- one clear action per section
- solid semantic accent
- compact height

Secondary:
- neutral outline or low-emphasis treatment

Destructive:
- explicit confirmation
- never hide the consequences

### Status badges
Examples:
- Draft
- Pending Approval
- Approved
- Rejected
- Partially Received
- Received
- Processing
- Completed
- Failed

Badges should be compact and consistent.

### Tables
Default style:
- 12–14px text
- right-align money/quantity columns
- left-align names/descriptions
- fixed status column
- row hover
- optional sticky header
- pagination
- export action where appropriate

### KPI cards
KPI cards should be compact, not promotional.

Example:
```text
NET SALES
₱2,481,920
+8.4% vs prior period
```

Include:
- label
- primary metric
- comparison or context
- optional status/trend
- click target for details

### Forms
Use labels above inputs, clear validation, and helper text only where needed.

Group configuration forms by operational purpose rather than by database table.

## 8. Executive Dashboard

The default dashboard should be a decision center.

Suggested order:
1. Global filters.
2. KPI strip: Sales / Gross Margin / Inventory Turnover / Labor Cost % / Supplier Reliability.
3. Cross-store P&L summary.
4. Sales trend.
5. Inventory/reorder alerts.
6. Pending approvals.
7. Labor summary.
8. Recent integration/sync health.

Every chart or KPI must provide a path to the underlying records.

## 9. Finance UX

Finance should feel controlled and precise.

Prefer:
- dense ledger tables
- account hierarchy
- clear debit/credit columns
- immutable posted status
- source-document links
- audit history
- reversal actions instead of delete

Posted transactions should visually communicate that they are locked.


## 9A. Management Dashboard — Required Visual Structure

The management dashboard should combine the clarity of a modern inventory dashboard with the density and control expected from a business back office. The visual references supplied for POSPLUS emphasize compact KPI cards, obvious selectors, practical charts, status indicators, and tables that let managers understand the business at a glance.

### Global dashboard header

At the top of the dashboard, provide a compact control bar containing:
- scope toggle/select: **Stores | Commissary**;
- store selector where applicable;
- period selector: **This Week | This Month | Custom Range**;
- refresh/status indicator when data is being synchronized.

The selected scope and date range must remain visually obvious while scrolling.

### Management overview KPI strip

For the general management/review view, prioritize a single horizontal KPI area near the top. Depending on selected scope, surface:
- Total Purchased;
- Total Sales;
- Remaining Inventory;
- Remaining Inventory Value;
- Wastage;
- Wastage %;
- Produced;
- Planned vs Actual Yield;
- Yield Difference %;
- Price-change/Procurement Alerts.

Use compact cards. A KPI should be readable in one glance and should link to its underlying detail.

If the business uses a configured 3.3x reference calculation, show it as a clearly named **reference/derived metric** with supporting context. Never label the derived figure as actual sales.

### Stores mode

The Stores dashboard should visually prioritize:
1. Inventory health KPI cards: total stock value, low-stock items, out-of-stock items, stock health.
2. Low-stock alert panel with severity/status and item count.
3. Daily Sales Summary with a compact trend/table view.
4. Monthly Sales Overview with a practical trend chart and exact-value table where useful.
5. Top-selling items across all stores, preferably with ranked horizontal bars plus exact values.

Use the visual language of the supplied inventory references: compact cards, ranked bars, status pills, and clear table rows. Avoid copying decorative mascots/illustrations; POSPLUS remains professional and ERP-oriented.

### Commissary mode

The Commissary dashboard should visually prioritize:
1. Inventory overview and inventory value.
2. Daily Production Summary.
3. Monthly Produced Overview.
4. Planned vs actual output/yield.
5. Wastage quantity and percentage.
6. Price-change alerts for recent actual purchase prices versus configured default/planned prices.

Production charts should make planned and actual results easy to compare without requiring hover to understand the basic difference.

### Procurement intelligence

Price-change alerts should show at minimum:
- ingredient;
- supplier;
- configured/default price;
- latest recorded purchase/quote price;
- absolute difference;
- percentage difference;
- date of latest price;
- alert severity.

Supplier recommendation panels should explain why a supplier is recommended, e.g. based on the latest recorded price, recent trend, and available purchase history. Recommendations must read as decision support, not automated purchasing.

A procurement trend view should allow the manager to inspect an ingredient and compare supplier price history over time.

### Information density

Follow these visual rules for dashboard density:
- KPI cards: compact height with strong numeric emphasis;
- charts: one clear question per chart;
- tables: exact values available without relying on charts;
- alerts: high-signal exceptions only;
- no oversized illustrations or empty decorative space;
- no chart without a useful drill-down or supporting exact values.

### Example dashboard composition

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Dashboard   [ Stores ▼ ] [ Main Store ▼ ] [ This Month ▼ ]  Last sync... │
├───────────────────────────────────────────────────────────────────────────┤
│ Purchased     Sales       Inventory      Inv. Value    Wastage     Yield │
│ ₱xxx,xxx      ₱xxx,xxx    xxx items      ₱xxx,xxx      x,xxx      xx.x% │
├───────────────────────────────────────────────────────────────────────────┤
│ Inventory Health / Alerts         │ Daily Sales / Monthly Trend           │
├───────────────────────────────────┼───────────────────────────────────────┤
│ Top Selling Items                 │ Procurement / Price Alerts            │
├───────────────────────────────────┴───────────────────────────────────────┤
│ Exact-value tables + drill-down links                                      │
└───────────────────────────────────────────────────────────────────────────┘
```

The exact arrangement may change by viewport, but the information hierarchy should remain equivalent.

## 10. Procurement UX

Purchase orders are workflow objects.

Make their state obvious at the top of the detail page:

```text
PO-000184     Pending Approval
Supplier      ABC Foods
Destination   Main Warehouse
Total         ₱184,500
```

Then show:
- lines
- totals
- approval timeline
- receiving
- document/PDF
- stock write-back status

Approval and rejection actions should be prominent but not easy to trigger accidentally.

## 11. Manufacturing UX

Manufacturing pages should emphasize:
- planned vs actual
- yield
- waste
- cost variance

For BOMs, show the cost rollup next to the component list.

For production orders, make the production lifecycle visually obvious without using a consumer-style progress gimmick.

## 12. Workforce UX

Prioritize exceptions:
- missing clock-ins
- unusual hours
- leave conflicts
- payroll calculation issues

Payroll should clearly separate:
- gross
- deductions
- net
- employer-side costs where configured

Finalized payroll should appear locked.

## 13. Analytics UX

Charts should be minimal and practical.

Use:
- line charts for trends
- bars for store comparisons
- tables for exact values
- compact legends
- clear date/store filters

Never force a chart where a table is more precise.

## 14. Empty States

Avoid marketing copy.

Good:
> No purchase orders match the selected filters.

Then:
> Clear filters or create a purchase order.

Bad:
> Your procurement journey starts here! Let's get purchasing!

## 15. Error States

Errors should answer:
1. what happened,
2. what the user can do,
3. whether the system already saved anything.

Example:
> Receiving could not be completed because the warehouse is unavailable in Loyverse. No stock write-back was performed. Retry after the integration is restored.

## 16. Loading States

Use skeletons for page-level data and inline spinners for actions.

Never make the whole application visibly "busy" for a local action.

## 17. Tables + Filters

Filtering is a core ERP interaction.

Common controls:
- date range
- store
- warehouse
- supplier
- status
- employee
- search

Persist useful filter state within the current page/session where appropriate.

## 18. Accessibility

Target WCAG-conscious implementation:
- keyboard navigation
- visible focus
- proper label associations
- semantic tables
- sufficient contrast
- screen-reader labels for icon-only actions
- non-color semantic state indicators

## 19. Motion

Use motion sparingly:
- subtle page transitions
- dropdown/overlay transitions
- loading indicators

Do not animate KPI numbers continuously or make operational tables move.

## 20. Responsive Behavior

Desktop is the primary workspace.

On smaller screens:
- collapse navigation
- allow horizontal table scrolling where necessary
- preserve critical columns
- turn multi-column forms into a single column
- keep primary actions accessible

Do not replace dense desktop tables with decorative cards without a clear information-equivalence strategy.

## 21. Brand Voice in Product UI

Tone:
- direct
- professional
- calm
- operational
- specific

Examples:
- "Approve purchase order"
- "Receive goods"
- "Sync now"
- "Review payroll"
- "3 receipts failed to post"
- "12 items below reorder point"

Avoid:
- "Awesome!"
- "You're crushing it!"
- "Let's make magic!"
- excessive exclamation marks
