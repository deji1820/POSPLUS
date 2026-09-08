/**
 * Development seed (SPEC.md §21).
 *
 * Creates a dev/admin account and a minimal test organization:
 * role membership, example store, example warehouse, chart of accounts,
 * baseline GL mappings, example supplier, example payroll rule, and the
 * initial SalesReferenceRule at 3.3 (SPEC.md §8).
 *
 * Credentials come exclusively from environment variables — never hardcode.
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ORG_NAME
 *
 * Run with: `pnpm db:seed` (DATABASE_URL must point at a migrated database,
 * e.g. the docker-compose Postgres: postgresql://posplus:posplus@localhost:5432/posplus).
 *
 * Passwords use Node's built-in scrypt. Issue #3 (Auth.js) must verify
 * logins with the same `verifyScryptPassword` helper.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Role, GLAccountType } from "@prisma/client";

import { hashPassword } from "../lib/auth/password";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (SPEC.md §21: credentials come from environment variables)`);
  }
  return value;
}

const DATABASE_URL = requiredEnv("DATABASE_URL");
const ADMIN_EMAIL = requiredEnv("SEED_ADMIN_EMAIL");
const ADMIN_PASSWORD = requiredEnv("SEED_ADMIN_PASSWORD");
const ORG_NAME = process.env.SEED_ORG_NAME ?? "POSPLUS Test Organization";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

// Minimal, recognizable baseline chart of accounts.
const BASELINE_COA: Array<{ code: string; name: string; type: GLAccountType }> = [
  { code: "1000", name: "Cash on Hand", type: GLAccountType.ASSET },
  { code: "1010", name: "Bank Account", type: GLAccountType.ASSET },
  { code: "1100", name: "Accounts Receivable", type: GLAccountType.ASSET },
  { code: "1200", name: "Inventory", type: GLAccountType.ASSET },
  { code: "2000", name: "Accounts Payable", type: GLAccountType.LIABILITY },
  { code: "2100", name: "Payroll Liabilities", type: GLAccountType.LIABILITY },
  { code: "3000", name: "Owner's Equity", type: GLAccountType.EQUITY },
  { code: "4000", name: "Sales Revenue", type: GLAccountType.REVENUE },
  { code: "4100", name: "Refunds (Contra Revenue)", type: GLAccountType.REVENUE },
  { code: "5000", name: "Cost of Goods Sold", type: GLAccountType.EXPENSE },
  { code: "6000", name: "Operating Expenses", type: GLAccountType.EXPENSE },
  { code: "6100", name: "Labor Cost", type: GLAccountType.EXPENSE },
];

async function main() {
  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      name: "POSPLUS Admin",
      passwordHash: hashPassword(ADMIN_PASSWORD),
    },
  });

  const organization = await prisma.organization.upsert({
    where: { id: "seed-org" },
    update: {},
    create: { id: "seed-org", name: ORG_NAME, currency: "USD", timezone: "UTC" },
  });

  await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: { organizationId: organization.id, userId: user.id },
    },
    update: { role: Role.OWNER },
    create: { organizationId: organization.id, userId: user.id, role: Role.OWNER },
  });

  const store = await prisma.store.upsert({
    where: {
      organizationId_loyverseStoreId: {
        organizationId: organization.id,
        loyverseStoreId: "seed-store-1",
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      loyverseStoreId: "seed-store-1",
      name: "Example Store",
      address: "1 Example Street",
    },
  });

  await prisma.warehouse.upsert({
    where: {
      organizationId_code: { organizationId: organization.id, code: "WH-MAIN" },
    },
    update: {},
    create: {
      organizationId: organization.id,
      storeId: store.id,
      name: "Main Warehouse",
      code: "WH-MAIN",
    },
  });

  for (const account of BASELINE_COA) {
    await prisma.gLAccount.upsert({
      where: {
        organizationId_code: { organizationId: organization.id, code: account.code },
      },
      update: {},
      create: { organizationId: organization.id, ...account },
    });
  }

  // Baseline mapping: default Loyverse payment types -> GL accounts.
  const cashAccount = await prisma.gLAccount.findFirstOrThrow({
    where: { organizationId: organization.id, code: "1000" },
  });
  const bankAccount = await prisma.gLAccount.findFirstOrThrow({
    where: { organizationId: organization.id, code: "1010" },
  });
  for (const paymentType of ["Cash", "Card"]) {
    await prisma.gLMapping.upsert({
      where: { id: `seed-mapping-${paymentType.toLowerCase()}` },
      update: {},
      create: {
        id: `seed-mapping-${paymentType.toLowerCase()}`,
        organizationId: organization.id,
        paymentType,
        accountId: paymentType === "Cash" ? cashAccount.id : bankAccount.id,
      },
    });
  }

  await prisma.supplier.upsert({
    where: { id: "seed-supplier-1" },
    update: {},
    create: {
      id: "seed-supplier-1",
      organizationId: organization.id,
      name: "Example Supplier Co.",
      leadTimeDays: 3,
    },
  });

  await prisma.employeePayRule.upsert({
    where: { id: "seed-pay-rule-1" },
    update: {},
    create: {
      id: "seed-pay-rule-1",
      organizationId: organization.id,
      // Linked to the seeded admin user so the example runs without
      // waiting for Loyverse employee sync; re-point after first sync.
      employeeId: (await seededEmployee(prisma, organization.id)) as string,
      rate: 15.0,
      overtimeRate: 22.5,
    },
  });

  // SPEC.md §8: seed the initial management sales-reference multiplier at 3.3.
  await prisma.salesReferenceRule.upsert({
    where: { id: "seed-sales-reference-rule" },
    update: {},
    create: {
      id: "seed-sales-reference-rule",
      organizationId: organization.id,
      multiplier: 3.3,
    },
  });

  console.log(`Seed complete: org "${organization.name}" (${organization.id}), admin ${user.email}`);
}

async function seededEmployee(prisma: PrismaClient, organizationId: string) {
  return (
    await prisma.employee.upsert({
      where: {
        organizationId_loyverseId: {
          organizationId,
          loyverseId: "seed-employee-1",
        },
      },
      update: {},
      create: {
        organizationId,
        loyverseId: "seed-employee-1",
        name: "Example Employee",
      },
    })
  ).id;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
