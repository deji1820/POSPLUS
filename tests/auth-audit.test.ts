/**
 * Auth lifecycle audit wiring (SPEC.md §17, issue #15).
 *
 * Covers the issue's "login/logout/security events" requirement at the unit
 * level: a wrong password for a KNOWN user records auth.login_failed, the
 * signIn event records auth.login, and the signOut event records auth.logout
 * (JWT strategy — the event carries the token). Unknown emails record
 * nothing (no org to audit against; the rate limit is their guard) — the
 * writer helper itself is covered in audit-writer.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  writeUserAuthAudit: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({ handlers: {}, auth: vi.fn() })),
}));

vi.mock("next-auth/providers/credentials", () => ({
  // Identity: the test drives credentialsAuthorize/authEvents directly, so
  // the provider just needs to carry the config through.
  default: vi.fn((config: unknown) => config),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: mocks.userFindUnique } },
}));

vi.mock("@/lib/audit/writer", () => ({
  AUDIT_ACTIONS: {
    AUTH: { LOGIN: "auth.login", LOGIN_FAILED: "auth.login_failed", LOGOUT: "auth.logout" },
  },
  writeUserAuthAudit: mocks.writeUserAuthAudit,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

import { authEvents, credentialsAuthorize } from "@/lib/auth/index";
import { hashPassword } from "@/lib/auth/password";

const USER = {
  id: "user-1",
  email: "admin@posplus.local",
  name: "Admin",
  status: "active",
  passwordHash: hashPassword("Passw0rd!123"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockReturnValue(true);
  mocks.writeUserAuthAudit.mockResolvedValue(undefined);
});

describe("credentialsAuthorize — login_failed audit (§17)", () => {
  it("records auth.login_failed when the password does not verify", async () => {
    mocks.userFindUnique.mockResolvedValue(USER);

    const result = await credentialsAuthorize({
      email: "ADMIN@posplus.local", // case/whitespace-insensitive
      password: "wrong-password",
    });

    expect(result).toBeNull();
    expect(mocks.writeUserAuthAudit).toHaveBeenCalledWith(
      "user-1",
      "auth.login_failed",
      { email: "admin@posplus.local" },
    );
  });

  it("records nothing for an unknown email (no org to audit against)", async () => {
    mocks.userFindUnique.mockResolvedValue(null);

    const result = await credentialsAuthorize({
      email: "ghost@posplus.local",
      password: "whatever",
    });

    expect(result).toBeNull();
    expect(mocks.writeUserAuthAudit).not.toHaveBeenCalled();
  });

  it("records nothing when the account is not active", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...USER, status: "invited" });

    const result = await credentialsAuthorize({
      email: "admin@posplus.local",
      password: "Passw0rd!123",
    });

    expect(result).toBeNull();
    expect(mocks.writeUserAuthAudit).not.toHaveBeenCalled();
  });
});

describe("authEvents — signIn/signOut audit (§17)", () => {
  it("signIn records auth.login with the user's id", async () => {
    await authEvents.signIn?.({ user: { id: "user-1", email: "a@b.c" } } as never);

    expect(mocks.writeUserAuthAudit).toHaveBeenCalledWith("user-1", "auth.login", {
      email: "a@b.c",
    });
  });

  it("signOut records auth.logout from the JWT token subject", async () => {
    await authEvents.signOut?.({ token: { sub: "user-1" } } as never);

    expect(mocks.writeUserAuthAudit).toHaveBeenCalledWith("user-1", "auth.logout");
  });

  it("signOut with a session-only event (no token) records nothing", async () => {
    await authEvents.signOut?.({ session: {} } as never);

    expect(mocks.writeUserAuthAudit).not.toHaveBeenCalled();
  });
});
