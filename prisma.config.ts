import { defineConfig } from "prisma/config";

// Prisma 7+ connection config (datasource `url` lives here, not in schema.prisma).
// Runtime clients use a driver adapter — see lib/db/ and SPEC.md §22.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // `prisma generate` loads this config but never connects, so a missing
    // DATABASE_URL must not hard-fail generation (postinstall runs it without
    // env, e.g. in CI). Commands that actually connect (migrate dev/deploy,
    // db seed) still require a real DATABASE_URL and will fail at connect time
    // if only the placeholder is present.
    url:
      process.env.DATABASE_URL ??
      "postgresql://placeholder:placeholder@localhost:5432/posplus_placeholder",
  },
});
