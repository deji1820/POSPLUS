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
import { PrismaClient, Role } from "@prisma/client";

import { hashPassword } from "../lib/auth/password";
import { ensureBaselineCoa } from "../lib/finance/baseline";

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

  // Baseline chart of accounts + default GL mappings (shared with the
  // post-sync setup checklist — lib/finance/baseline.ts, #10).
  await ensureBaselineCoa(organization.id);

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
