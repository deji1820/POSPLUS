import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/posplus?schema=public";

describe("prisma schema (SPEC.md §8)", () => {
  it("passes `prisma validate`", { timeout: 30_000 }, () => {
    expect(() =>
      execSync("pnpm exec prisma validate", {
        env: { ...process.env, DATABASE_URL },
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
