import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSessionUser } from "@/lib/auth/app-sessions";

const { transaction, lockedAccount, verifyPassword, rateLimit, sendEmail, findMailbox, createToken } = vi.hoisted(() => ({
  transaction: vi.fn(), lockedAccount: vi.fn(), verifyPassword: vi.fn(), rateLimit: vi.fn(),
  sendEmail: vi.fn(), findMailbox: vi.fn(), createToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: transaction } }));
vi.mock("@/lib/identity/mail", () => ({ sendIdentityEmail: sendEmail }));
vi.mock("@/lib/identity/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/identity/shared")>(),
  requireLockedAccount: lockedAccount, verifyIdentityPassword: verifyPassword, takeIdentityRateLimit: rateLimit,
}));

import { prepareEmailVerification, requestEmailVerification } from "@/lib/identity/account";
import { IdentityError } from "@/lib/identity/shared";

const session: AccountSessionUser = { id: "own-account", appSessionId: "own-session", email: "own@example.com", name: "Owner" };
const user = {
  id: session.id, email: session.email, displayName: "Owner", status: "ACTIVE", passwordHash: "stored-password-hash",
  emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"), createdAt: new Date(), updatedAt: new Date(),
};
const input = { email: "replacement@example.com", currentPassword: "current-fixture-password", locale: "en-US" as const };

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
    user: { findFirst: findMailbox }, accountToken: { create: createToken },
  }));
  lockedAccount.mockResolvedValue({ ...user });
  verifyPassword.mockResolvedValue({ passwordHash: user.passwordHash });
  rateLimit.mockResolvedValue(undefined);
  findMailbox.mockResolvedValue({ id: "different-account" });
  sendEmail.mockResolvedValue(undefined);
});

describe("email verification preparation before a deferred response", () => {
  it("rejects an invalid current password before creating a delivery task", async () => {
    verifyPassword.mockRejectedValueOnce(new IdentityError("PASSWORD_INVALID"));
    await expect(prepareEmailVerification(session, input)).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    expect(findMailbox).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid session before creating a delivery task", async () => {
    lockedAccount.mockRejectedValueOnce(new IdentityError("UNAUTHORIZED"));
    await expect(prepareEmailVerification(session, input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(findMailbox).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("prepares without any target-account lookup, mail or credential creation", async () => {
    const prepared = await prepareEmailVerification(session, input);
    expect(prepared).toEqual({ kind: "change-email", deliver: expect.any(Function) });
    expect(JSON.stringify(prepared)).toBe('{"kind":"change-email"}');
    expect(verifyPassword).toHaveBeenCalledExactlyOnceWith(session, input.currentPassword);
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith("email-verify", session.id);
    expect(findMailbox).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("checks target ownership only during delivery without re-verifying the password", async () => {
    const prepared = await prepareEmailVerification(session, input);
    expect(findMailbox).not.toHaveBeenCalled();
    expect(await prepared.deliver()).toEqual({ accepted: true });
    expect(findMailbox).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(createToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rechecks the original password binding before deferred delivery", async () => {
    const prepared = await prepareEmailVerification(session, input);
    lockedAccount.mockResolvedValueOnce({ ...user, passwordHash: "a-later-password-hash" });
    await expect(prepared.deliver()).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(findMailbox).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rechecks the original session before deferred delivery", async () => {
    const prepared = await prepareEmailVerification(session, input);
    lockedAccount.mockRejectedValueOnce(new IdentityError("UNAUTHORIZED"));
    await expect(prepared.deliver()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(findMailbox).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("keeps current-mailbox verification synchronous and does not require another password check", async () => {
    const prepared = await prepareEmailVerification(session, {});
    expect(prepared.kind).toBe("verify-current");
    expect(await prepared.deliver()).toEqual({ accepted: true });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(findMailbox).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("preserves the direct wrapper without spending the password budget twice", async () => {
    expect(await requestEmailVerification(session, input)).toEqual({ accepted: true });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });
});
