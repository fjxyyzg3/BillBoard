import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  accountSession: vi.fn(), householdSession: vi.fn(), signOut: vi.fn(), revalidate: vi.fn(),
  overview: vi.fn(), requestVerification: vi.fn(), changePassword: vi.fn(), revokeSession: vi.fn(), requestReset: vi.fn(), completeVerification: vi.fn(), resetPassword: vi.fn(),
  createInvitation: vi.fn(), revokeInvitation: vi.fn(), preview: vi.fn(), startRegistration: vi.fn(), completeRegistration: vi.fn(), accept: vi.fn(),
  leave: vi.fn(), remove: vi.fn(), transfer: vi.fn(),
  after: vi.fn(), rateLimit: vi.fn(), prepareVerification: vi.fn(), deliverVerification: vi.fn(), revokeCurrentSession: vi.fn(),
}));
vi.mock("@/auth", () => ({ signOut: harness.signOut }));
vi.mock("next/cache", () => ({ revalidatePath: harness.revalidate }));
vi.mock("next/server", () => ({ after: harness.after }));
vi.mock("@/lib/auth/session", () => ({ requireAccountSession: harness.accountSession, requireAppSession: harness.householdSession }));
vi.mock("@/lib/identity/account", () => ({ getAccountOverview: harness.overview, prepareEmailVerification: harness.prepareVerification, requestEmailVerification: harness.requestVerification, changeAccountPassword: harness.changePassword, revokeOwnSession: harness.revokeSession, revokeCurrentAccountSession: harness.revokeCurrentSession, requestPasswordReset: harness.requestReset, completeEmailVerification: harness.completeVerification, resetAccountPassword: harness.resetPassword }));
vi.mock("@/lib/identity/invitations", () => ({ createHouseholdInvitation: harness.createInvitation, revokeHouseholdInvitation: harness.revokeInvitation, getInvitationPreview: harness.preview, startInvitedRegistration: harness.startRegistration, completeInvitedRegistration: harness.completeRegistration, acceptInvitation: harness.accept }));
vi.mock("@/lib/identity/households", () => ({ leaveHousehold: harness.leave, removeHouseholdMember: harness.remove, transferHouseholdOwnership: harness.transfer }));
vi.mock("@/lib/identity/shared", () => ({ IdentityError: class IdentityError extends Error { constructor(public code: string) { super(code); } }, takeIdentityRateLimit: harness.rateLimit }));

import { changeHouseholdMembershipAction, changeOwnEmailAction, changeOwnPasswordAction, finishReauthenticationAction, revokeOwnSessionAction, signOutAccountAction, verifyOwnEmailAction } from "@/app/account/actions";
import { acceptInvitationAction, completeIdentityLinkAction, getLinkAccountAction, previewInvitationAction, signOutLinkAccountAction } from "@/app/(auth)/account-link/actions";
import { requestPasswordResetAction } from "@/app/(auth)/forgot-password/actions";
import { IdentityError } from "@/lib/identity/shared";

const session = { id: "account", appSessionId: "session", email: "member@example.test", name: "Member", householdId: "household", memberId: "member", role: "OWNER" };
function form(data: Record<string, string> = {}) { const result = new FormData(); for (const [key, value] of Object.entries(data)) result.set(key, value); return result; }

beforeEach(() => {
  vi.resetAllMocks();
  harness.accountSession.mockResolvedValue(session);
  harness.householdSession.mockResolvedValue(session);
  harness.revokeSession.mockResolvedValue({ revoked: true, requiresReauthentication: false });
  harness.prepareVerification.mockResolvedValue({ kind: "change-email", deliver: harness.deliverVerification });
});

describe("identity action boundaries", () => {
  it.each([
    ["account", signOutAccountAction, { redirectTo: "/login" }],
    ["invitation", signOutLinkAccountAction, { redirect: false }],
  ] as const)("revokes the current server session before clearing the %s browser authentication", async (_name, action, options) => {
    let finishRevocation!: () => void;
    harness.revokeCurrentSession.mockImplementation(() => new Promise<void>((resolve) => { finishRevocation = resolve; }));
    const signingOut = action();
    await vi.waitFor(() => expect(harness.revokeCurrentSession).toHaveBeenCalledWith(session));
    expect(harness.signOut).not.toHaveBeenCalled();
    finishRevocation();
    await signingOut;
    expect(harness.signOut).toHaveBeenCalledWith(options);
  });

  it("keeps the current cookie available for retry if server-side revocation fails", async () => {
    harness.revokeCurrentSession.mockRejectedValue(new Error("database unavailable"));
    await expect(signOutAccountAction()).rejects.toThrow("database unavailable");
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it("still clears browser authentication after a session has already become invalid", async () => {
    harness.accountSession.mockRejectedValue(new Error("Unauthorized"));
    await signOutLinkAccountAction();
    expect(harness.revokeCurrentSession).not.toHaveBeenCalled();
    expect(harness.signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("requires the server account context and never trusts a client user or household", async () => {
    await revokeOwnSessionAction(form({ userId: "other", householdId: "other-household", sessionId: "target-session" }));
    expect(harness.revokeSession).toHaveBeenCalledWith(session, "target-session");
    expect(harness.accountSession).toHaveBeenCalledTimes(1);
    harness.accountSession.mockRejectedValueOnce(new Error("Unauthorized"));
    expect(await verifyOwnEmailAction(form())).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(harness.requestVerification).not.toHaveBeenCalled();
  });

  it("forwards only the intended email fields and keeps verification conditionally worded", async () => {
    const result = await changeOwnEmailAction(form({ email: "new@example.test", currentPassword: "current", locale: "en-US", userId: "other" }));
    expect(harness.prepareVerification).toHaveBeenCalledWith(session, { email: "new@example.test", currentPassword: "current", locale: "en-US" });
    expect(result).toEqual({ ok: true, data: { message: "accepted" } });
    expect(harness.deliverVerification).not.toHaveBeenCalled();
    await harness.after.mock.calls[0][0]();
    expect(harness.deliverVerification).toHaveBeenCalledTimes(1);
  });

  it("does not mutate membership without confirmation and rechecks household authority on each action", async () => {
    expect(await changeHouseholdMembershipAction(form({ operation: "remove", memberId: "target" }))).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.remove).not.toHaveBeenCalled();
    await changeHouseholdMembershipAction(form({ operation: "remove", memberId: "target", currentPassword: "current", confirmed: "on", householdId: "forged" }));
    expect(harness.remove).toHaveBeenCalledWith(session, "target", "current");
    expect(harness.householdSession).toHaveBeenCalledTimes(2);
    expect(harness.accountSession).not.toHaveBeenCalled();
  });

  it("requires matching passwords on the server and ends browser authentication only after success", async () => {
    expect(await changeOwnPasswordAction(form({ newPassword: "first", confirmPassword: "different" }))).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.changePassword).not.toHaveBeenCalled();
    expect(harness.signOut).not.toHaveBeenCalled();
    expect(await changeOwnPasswordAction(form({ currentPassword: "old", newPassword: "replacement", confirmPassword: "replacement" }))).toEqual({ ok: true, data: { reauthenticate: true } });
    expect(harness.changePassword).toHaveBeenCalledWith(session, { currentPassword: "old", newPassword: "replacement" });
    expect(harness.signOut).not.toHaveBeenCalled();
    await finishReauthenticationAction();
    expect(harness.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/login?reason=account-updated" });
  });

  it("previews a token without consuming it and exposes only the safe invitation DTO", async () => {
    harness.preview.mockResolvedValue({ purpose: "HOUSEHOLD", email: "invitee@example.test", householdName: "Family", expiresAt: new Date("2026-11-01T00:00:00Z"), tokenHash: "not-for-client", householdId: "internal" });
    expect(await previewInvitationAction("opaque-token")).toEqual({ ok: true, data: { purpose: "HOUSEHOLD", email: "invitee@example.test", householdName: "Family", expiresAt: "2026-11-01T00:00:00.000Z" } });
    expect(harness.accept).not.toHaveBeenCalled();
    expect(harness.completeRegistration).not.toHaveBeenCalled();
    expect(harness.completeVerification).not.toHaveBeenCalled();
  });

  it("requires an explicit authenticated invitation confirmation and discards internal result IDs", async () => {
    expect(await acceptInvitationAction("capability", form({ memberName: "Family member" }))).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.accept).not.toHaveBeenCalled();
    harness.accept.mockResolvedValue({ householdId: "new-household", memberId: "new-member" });
    expect(await acceptInvitationAction("capability", form({ confirmed: "on", memberName: "Family member", householdId: "forged", role: "OWNER" }))).toEqual({ ok: true, data: { reauthenticate: true } });
    expect(harness.accept).toHaveBeenCalledWith(session, "capability", { memberName: "Family member", householdName: undefined });
    expect(harness.signOut).not.toHaveBeenCalled();
    await finishReauthenticationAction();
    expect(harness.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/login?reason=account-updated" });
  });

  it("keeps account-only sessions usable and strips sessions from the invitation account check", async () => {
    harness.accountSession.mockResolvedValue({ ...session, householdId: undefined, memberId: undefined });
    harness.overview.mockResolvedValue({ email: session.email, displayName: "Member", emailVerifiedAt: null, sessions: [{ id: "private-session" }] });
    expect(await getLinkAccountAction()).toEqual({ ok: true, data: { email: session.email, displayName: "Member", emailVerifiedAt: null, hasHousehold: false } });
    harness.accountSession.mockRejectedValue(new Error("Unauthorized"));
    expect(await getLinkAccountAction()).toEqual({ ok: true, data: null });
  });

  it("does not disclose raw errors and never logs a rejected capability", async () => {
    harness.completeVerification.mockRejectedValue(new Error("smtp://private-password/secret-token"));
    expect(await completeIdentityLinkAction("verify", "secret-token", form())).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(harness.signOut).not.toHaveBeenCalled();
    harness.completeVerification.mockRejectedValue(new IdentityError("INVALID_TOKEN"));
    expect(await completeIdentityLinkAction("verify", "secret-token", form())).toEqual({ ok: false, code: "INVALID_TOKEN" });
  });

  it("uses the same conditional recovery response without claiming delivery", async () => {
    expect(await requestPasswordResetAction(form({ email: "unknown@example.test", locale: "en-US" }))).toEqual({ ok: true, data: { message: "accepted" } });
    expect(harness.requestReset).not.toHaveBeenCalled();
    expect(harness.rateLimit).toHaveBeenCalledWith("public-mail", "unknown@example.test");
    await harness.after.mock.calls[0][0]();
    expect(harness.requestReset).toHaveBeenCalledWith("unknown@example.test", "en-US");
  });

  it("responds before either known or unknown recovery processing and contains background failures", async () => {
    harness.requestReset.mockRejectedValue(new Error("provider detail"));
    for (const email of ["known@example.test", "unknown@example.test"]) {
      expect(await requestPasswordResetAction(form({ email }))).toEqual({ ok: true, data: { message: "accepted" } });
    }
    expect(harness.requestReset).not.toHaveBeenCalled();
    expect(harness.after).toHaveBeenCalledTimes(2);
    for (const [callback] of harness.after.mock.calls) await expect(callback()).resolves.toBeUndefined();
    expect(harness.requestReset).toHaveBeenCalledTimes(2);
  });

  it("bounds public recovery work before scheduling and keeps rate-limited acceptance identical", async () => {
    harness.rateLimit.mockRejectedValue(new IdentityError("RATE_LIMITED"));
    expect(await requestPasswordResetAction(form({ email: "  KNOWN@example.test " }))).toEqual({ ok: true, data: { message: "accepted" } });
    expect(harness.rateLimit).toHaveBeenCalledWith("public-mail", "known@example.test");
    expect(harness.after).not.toHaveBeenCalled();
    expect(harness.requestReset).not.toHaveBeenCalled();
  });
});
