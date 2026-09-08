import { defineConfig, env } from "prisma/config";

// Prisma 7+ connection config (datasource `url` lives here, not in schema.prisma).
// Runtime clients use a driver adapter — see lib/db/ and SPEC.md §22.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
