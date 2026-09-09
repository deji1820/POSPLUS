import { describe, expect, it } from "vitest";

import { hashPassword, verifyScryptPassword } from "@/lib/auth/password";

describe("scrypt password hashing (#3 / #8)", () => {
  it("round-trips a correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyScryptPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyScryptPassword("wrong password", stored)).toBe(false);
  });

  it("produces unique salts for identical passwords", () => {
    expect(hashPassword("same-password")).not.toEqual(hashPassword("same-password"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyScryptPassword("x", "not-a-hash")).toBe(false);
    expect(verifyScryptPassword("x", "bcrypt:salt:hash")).toBe(false);
  });
});
