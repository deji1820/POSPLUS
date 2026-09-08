# POSPLUS — Coding Agent Instructions

## Mission

Build POSPLUS as a secure, multi-tenant, web-based ERP/back-office layer on top of an existing Loyverse POS account. Do not replace the POS. Implement only official Loyverse APIs and webhooks.

The authoritative functional requirements are in `SPEC.md`; visual/product-design direction is in `BRAND.md`.

## Required Stack

- Next.js for frontend + backend.
- TypeScript.
- Node.js runtime.
- Prisma ORM.
- PostgreSQL on Railway.
- Redis + BullMQ.
- Tailwind CSS.
- Auth.js / NextAuth with credentials provider.
- S3-compatible storage for durable generated documents.
- `@react-pdf/renderer` or Puppeteer.
- pnpm.
- Railway for web, worker, Postgres, and Redis.
- Docker Compose for local Postgres/Redis/MinIO when useful.

The source brief explicitly requires this stack and deployment model. fileciteturn0file0L73-L103

## Dependency Rules

1. Use current stable releases compatible with the project at implementation time.
2. Prefer official packages and maintained integrations.
3. Use `pnpm` exclusively for package management.
4. Commit the lockfile.
5. Audit dependencies for known vulnerabilities.
6. Avoid unnecessary dependencies.
7. Before upgrading major versions, run the full test suite and build.
8. Do not claim a package is "latest" without checking the package registry/documentation during implementation.

## Architecture Rules

### Separation of concerns
- Route handlers/actions: authentication, validation, authorization, orchestration.
- Domain services: accounting, procurement, manufacturing, workforce, analytics.
- Repositories/data access: Prisma queries and transaction boundaries.
- Integration adapters: Loyverse client, object storage, PDF renderer.
- Workers: background and scheduled processing.
- Components: presentational UI and reusable workflow components.

Do not put business logic directly in page components.

### Server-first security
Anything involving:
- credentials
- API keys
- webhook secrets
- database access
- organization authorization
- role permissions
- financial posting
- payroll finalization
- external write-back

must execute server-side.

## Multi-Tenancy

Every query must be organization-scoped.

Required pattern:
```ts
await prisma.purchaseOrder.findFirst({
  where: {
    id: input.id,
    organizationId: session.organizationId,
  },
});
```

Never fetch by record ID alone when the record is tenant-owned.

For nested writes, validate parent ownership in the same transaction or through safe relation constraints.

Do not accept `organizationId` from the browser as authoritative. Derive it from the authenticated session/context.

## Authentication and RBAC

Use Auth.js credentials provider.

Implement:
- hashed passwords
- secure sessions/cookies
- login rate limits
- account status
- organization memberships
- role checks
- store/warehouse access checks

Roles:
- Owner
- Store Manager
- Accountant/Bookkeeper
- Warehouse Staff
- HR Admin

Permission checks belong in reusable server-side authorization helpers.

Example:
```ts
await requirePermission(session, "PURCHASE_ORDER_APPROVE");
```

Never trust a hidden button or disabled input as authorization.

## Secret Handling

Treat all Loyverse API keys and webhook secrets as sensitive credentials.

Source requirement: never expose credentials to the client; store them encrypted at rest. fileciteturn0file0L64-L68

Rules:
- Store encrypted ciphertext, not plaintext.
- Use an application encryption key from environment secrets.
- Use versioned encryption so rotation is possible.
- Decrypt only immediately before an outbound provider request.
- Never serialize decrypted credentials into React props.
- Never return credentials from an API route.
- Never log credentials.
- Redact credentials from caught errors.
- Never commit `.env` files containing real secrets.

## Loyverse Integration

Use an isolated adapter:

```text
lib/loyverse/
  client.ts
  auth.ts
  pagination.ts
  types.ts
  mapper.ts
  webhook.ts
```

Do not scatter provider-specific HTTP calls across the app.

The integration must use official documented APIs and webhooks only. fileciteturn0file0L37-L40

### API client
Implement:
- timeout
- bounded retries
- exponential backoff
- provider error normalization
- rate-limit handling
- pagination
- request correlation IDs

### Initial sync
Initial sync:
1. stores
2. categories
3. items
4. variants
5. employees
6. customers
7. historical receipts/refunds

Run through BullMQ. Never execute a potentially large historical sync inside a web request.

### Webhooks
Public endpoint:
`POST /api/loyverse/webhook`

Before processing:
1. verify signature/secret;
2. validate body schema;
3. validate event identity;
4. prevent replay/duplicate processing;
5. persist event;
6. enqueue processing job.

Source requirement: validate and verify all incoming webhook payloads before processing. fileciteturn0file0L67-L70

Return a fast 2xx after successful acceptance/queueing. Avoid doing heavy work synchronously.

## Idempotency

Every integration event and external write-back must be idempotent.

Use stable external IDs and unique database constraints.

Example:
```text
organizationId + provider + externalEventId
organizationId + provider + externalReceiptId
organizationId + provider + externalItemId
```

For inventory write-backs:
- create an internal operation record;
- attach a unique idempotency key;
- persist provider result;
- retry only when safe.

Never perform the same external stock write twice because a worker retried after an uncertain network response.

## Database Rules

Use Prisma + PostgreSQL.

### Money
Use `Decimal`/numeric database types. Never calculate money using binary floating-point.

### Transactions
Wrap state transitions in transactions:
- ledger posting
- PO approval where dependent records change
- goods receiving
- payroll finalization
- production completion
- tenant-sensitive configuration changes where atomicity matters

### Constraints
Enforce:
- organization ownership
- unique external IDs per tenant
- nonnegative quantities where applicable
- valid enum/state transitions
- balanced journal entries

## Accounting

Source requirement: financial data must be append-only/auditable, with no hard deletes on posted records. fileciteturn0file0L69-L71

Rules:
- Posted `JournalEntry` and `JournalLine` records cannot be updated or deleted.
- Corrections use reversing entries.
- Every journal entry must balance.
- Receipt/refund source records must be traceable.
- Record who/what triggered a posting.
- Never silently modify historical accounting output.

Validation:
```text
sum(debits) == sum(credits)
```

Enforce this in the domain service and database transaction, not only in UI.

## Procurement

State machine:
```text
DRAFT
PENDING_APPROVAL
APPROVED
REJECTED
PARTIALLY_RECEIVED
RECEIVED
CANCELLED
```

Do not allow arbitrary client-provided status values.

Approval:
- user must have PO approval permission;
- user must be in the organization;
- optionally prevent self-approval for policies that require separation of duties;
- record approval timestamp and actor.

Receiving:
- validate quantities;
- create goods receipt;
- inventory movement;
- initiate Loyverse stock update;
- record the result;
- prevent duplicate receipt posting.

## Manufacturing

BOM changes should be version-aware.

Recommended:
- draft BOM versions may be edited;
- published versions become immutable;
- future changes create a new draft/version;
- production orders point to the version used at release.

Production completion must record:
- consumed components
- output
- waste
- actual cost
- yield variance

## Workforce and Payroll

Payroll is financially sensitive.

Rules:
- source shifts from synchronized data;
- validate anomalies before calculation;
- snapshot relevant pay rules into payroll lines;
- finalized runs become immutable;
- adjustments use separate records;
- audit every approval/finalization.

Never overwrite a finalized payroll line just because a source shift changed later.

## Analytics

Prefer queryable normalized data or materialized/read-model tables for expensive reports.

Do not recalculate very large historical dashboards on every page render if a background aggregate can provide equivalent results.

Always carry:
- organization scope
- store scope
- date scope

Metric definitions belong in domain modules so UI and exports use the same calculations.

## Background Jobs

Redis + BullMQ.

Required jobs include:
- initial Loyverse sync
- webhook processing
- receipt/refund finance posting
- nightly reorder recalculation
- supplier scorecard refresh
- payroll batch runs
- document generation
- recurring report generation

Workers must be safe to restart.

For every job:
- stable job ID where possible
- bounded retries
- backoff
- structured logging
- safe idempotency
- dead-letter / failed state
- operator-visible failure summary

## Scheduled Tasks

Use Railway cron or a controlled scheduler.

At minimum:
- nightly reorder calculations
- recurring reports
- reconciliation
- stale-failure detection

Avoid multiple scheduler instances creating duplicate scheduled jobs. Use queue/job uniqueness or a distributed lock where required.

## PDF Documents

Keep PDF generation in `lib/pdf`.

Documents:
- Purchase Orders
- Payslips
- P&L/financial reports

Generate asynchronously when practical.

Store the final file in S3-compatible object storage, not local persistent volume.

## API Design

For every endpoint:
1. authenticate;
2. authorize;
3. validate input;
4. resolve tenant;
5. execute domain service;
6. return normalized result;
7. include request ID for errors.

Never return raw Prisma objects indiscriminately. Map API responses to explicit DTOs.

Use a consistent error contract.

## Validation

Use a schema validation library already supported by the chosen stack.

Validate:
- body
- query params
- route params
- uploaded document metadata
- webhook payloads
- provider responses where practical

Reject unexpected privileged fields such as:
- `organizationId`
- `role`
- `approvedBy`
- `postedAt`
- `isFinalized`

when they are not supposed to be client-controlled.


## Management Dashboard Requirements

The management dashboard is a primary product surface and must be implemented from the dashboard requirements in `SPEC.md`. Do not treat it as a generic summary page. It has two operational modes selected by a top-level context filter: **Stores** and **Commissary**.

### Global dashboard controls

The dashboard must provide:
- operational scope selector: `Stores` or `Commissary`;
- store selector/filter when the selected scope supports store-level analysis;
- period selector with at least `This Week`, `This Month`, and `Custom Range`;
- a consistent date range passed to every applicable KPI, chart, alert, and recommendation query;
- an explicit indication of the selected period and scope.

Changing the period must refresh the dashboard from the same canonical metric definitions used by reports and exports. Do not calculate one KPI from current state while calculating another from a different period unless the metric definition explicitly requires a point-in-time value.

### Store dashboard

For `Stores`, implement these sections:
1. Inventory Dashboard: total stock value, low-stock items, out-of-stock items, and stock health.
2. Low-stock alerts.
3. Daily Sales Summary for the selected period/context, with daily values and relevant comparison context.
4. Monthly Sales Overview for store sales analysis.
5. Top-selling items across all stores, with the ability to drill into store/item detail.

### Commissary dashboard

For `Commissary`, implement:
1. Inventory Dashboard.
2. Daily Production Summary.
3. Monthly Produced Overview.
4. Price-change alerts comparing recent actual purchase prices against the configured default/planned prices.

### One-glance management overview

When a management overview is shown, the dashboard should surface these high-level metrics for the selected week/month/custom range as applicable:
- total purchased;
- total sales;
- total remaining inventory across stores and commissary, including inventory value;
- total wastage and wastage percentage;
- total produced;
- planned vs actual yield and percentage difference;
- relevant procurement price-change alerts and supplier recommendations.

The dashboard may show a derived management reference figure based on the configured business rule (for example, a 3.3x sales/purchases reference). This derived figure must be labeled clearly as a calculated/reference metric and must never replace or overwrite the actual `Total Sales` value. Its formula must live in a shared domain metric service so the dashboard, reports, and exports agree.

### Production metrics

Production widgets must use consistent formulas for:
- planned quantity/yield;
- actual quantity/yield;
- yield variance and percentage difference;
- wastage quantity;
- wastage percentage.

Production data must remain traceable to production orders, BOM/recipe versions, consumed ingredients, and recorded outputs/waste.

### Procurement price intelligence

Maintain historical supplier purchase prices per ingredient. The data model and services must support:
- supplier master records;
- ingredient-to-supplier relationships;
- purchase-price history with effective/purchase dates;
- configured default/planned prices;
- recent-vs-default price variance;
- price-change alerts;
- supplier/ingredient price trends;
- comparison of available recent supplier prices;
- recommendations for where to buy based on the latest recorded prices.

A recommendation is advisory only. It must be explainable from stored supplier/price history and current entered purchase information. The system must not imply that a supplier was contacted automatically unless such an integration actually exists.

When a purchaser calls a supplier and manually enters the quoted price, preserve that quote/purchase-price record with supplier, ingredient, unit, quantity where applicable, timestamp/date, and source context so later recommendations and trend charts can use it.

### Dashboard data architecture

Do not embed metric calculations separately inside React components. Put formulas and aggregation logic in shared domain services/read models so that:
- dashboard cards;
- charts;
- drill-down pages;
- exports; and
- scheduled reports
use the same definitions.

Prefer pre-aggregated/read-model data or efficient PostgreSQL queries for dashboard performance. Every analytics query must apply organization scope and, where relevant, store/warehouse/commissary and date scope.

### Dashboard API and authorization

Dashboard endpoints must be server-side and authorization-aware. A client must never be able to change organization scope or access another organization's metrics by changing query parameters.

Recommended endpoint shape:
`GET /api/dashboard/overview?scope=stores|commissary&storeId=&from=&to=`

Additional specialized endpoints may be used for inventory, sales, production, price alerts, supplier trends, and recommendations when separation improves maintainability. All responses should use explicit DTOs and include enough context to render the selected scope/period without exposing raw Prisma models.

### Background processing

Use BullMQ/background jobs for expensive or recurring calculations, including:
- daily/periodic dashboard aggregate refreshes where needed;
- production and wastage aggregate refresh;
- supplier price trend refresh;
- procurement alert evaluation;
- supplier recommendation candidate generation.

Dashboard reads should remain fast enough for interactive management use. Worker failures must be visible to operators and must not silently produce stale numbers.

## UI Rules

Follow `BRAND.md`.

The UI should:
- be desktop-first;
- be data-dense;
- prioritize tables and workflow details;
- use compact KPI cards;
- provide filters;
- make state obvious;
- show useful errors;
- avoid consumer-app patterns.

All critical operations require clear confirmation where appropriate.

## Audit Log

Create audit records for:
- authentication/security events where applicable
- organization changes
- role/permission changes
- integration changes
- sync runs
- webhook outcomes
- PO workflows
- inventory adjustments
- BOM publication
- production completion
- payroll calculation/finalization
- journal posting/reversal
- document generation

Do not store raw credentials or unnecessary sensitive payloads in audit metadata.

## Testing

Minimum test layers:
- unit
- integration
- end-to-end

Critical invariants must have tests:
- tenant isolation
- RBAC
- balanced journal entries
- append-only posted records
- webhook signature verification
- webhook idempotency
- PO state transitions
- receiving idempotency
- reorder formula
- BOM cost calculation
- payroll calculation/finalization

Add regression tests for every production bug involving financial data, tenant isolation, permissions, or external write-back.

## Seed

`prisma/seed.ts` must create an admin user using environment-provided credentials.

Never hardcode a real password.

Seed a minimal tenant and representative master data to enable local demos.

## Local Development

Provide:
- `.env.example`
- `docker-compose.yml`
- migration scripts
- seed script
- one-command local setup documented in `README.md`

Suggested flow:
```bash
pnpm install
docker compose up -d
pnpm prisma migrate dev
pnpm prisma db seed
pnpm dev
```

Use MinIO for local object-storage testing when needed.

## Deployment

Railway services:
- web
- worker
- PostgreSQL
- Redis

The worker must be a persistent process because the application depends on long-running queue consumers. fileciteturn0file0L80-L93

Use separate production secrets per environment.

Production checklist:
- secure auth secret
- encryption key
- database backups
- Redis availability
- S3 credentials
- webhook secret
- HTTPS
- security headers
- rate limiting
- logging/monitoring
- worker health
- migration strategy

## Coding Style

- TypeScript strict mode.
- Prefer small, composable domain functions.
- Avoid `any`.
- Avoid hidden global mutable state.
- Keep provider adapters isolated.
- Keep business rules testable without HTTP.
- Add comments only when they clarify non-obvious invariants.
- Use meaningful names over abbreviations.
- Keep route handlers thin.
- Run formatter, linter, typecheck, tests, and production build before considering a feature complete.

## Implementation Order

1. Repository/bootstrap and environment.
2. Prisma schema + migrations + seed.
3. Auth.js + organization/RBAC.
4. Application shell + navigation.
5. Loyverse credential storage + client.
6. Initial sync + webhook ingestion.
7. Finance posting + ledger.
8. Inventory + reorder suggestions.
9. Suppliers + PO workflow + receiving/write-back.
10. BOM + production.
11. Workforce + payroll + leave.
12. Analytics + consolidated reporting.
13. PDF/object storage.
14. Audit/observability hardening.
15. End-to-end demo scenario and deployment validation.

## Final Quality Gate

Before declaring the application complete, verify:
- no tenant-crossing reads/writes;
- no client-exposed secrets;
- every webhook is verified;
- financial/payroll posted data is append-only;
- external operations are idempotent;
- all major workflows have audit events;
- workers survive retries/restarts;
- generated documents are stored durably;
- current dependency versions are recorded in the lockfile;
- the app builds and tests cleanly.
