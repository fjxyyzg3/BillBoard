import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  account: vi.fn(), household: vi.fn(), signOut: vi.fn(), close: vi.fn(), deactivate: vi.fn(),
}));
vi.mock("@/auth", () => ({ signOut: harness.signOut }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAccountSession: harness.account, requireAppSession: harness.household }));
vi.mock("@/lib/identity/account", () => ({
  changeAccountPassword: vi.fn(), prepareEmailVerification: vi.fn(), requestEmailVerification: vi.fn(),
  revokeOwnSession: vi.fn(), deactivateOwnAccount: harness.deactivate,
  revokeCurrentAccountSession: vi.fn(),
}));
vi.mock("@/lib/identity/invitations", () => ({ createHouseholdInvitation: vi.fn(), revokeHouseholdInvitation: vi.fn() }));
vi.mock("@/lib/identity/households", () => ({
  leaveHousehold: vi.fn(), removeHouseholdMember: vi.fn(), transferHouseholdOwnership: vi.fn(), closeHousehold: harness.close,
}));

import { changeHouseholdMembershipAction, deactivateOwnAccountAction, finishReauthenticationAction } from "@/app/account/actions";
import { IdentityError } from "@/lib/identity/shared";

const session = {
  id: "own-account", appSessionId: "own-session", email: "owner@example.com", name: "Owner",
  householdId: "own-household", memberId: "own-member", role: "OWNER",
};
function form(fields: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) result.set(key, value);
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.account.mockResolvedValue(session);
  harness.household.mockResolvedValue(session);
  harness.close.mockResolvedValue({ requiresReauthentication: true });
  harness.deactivate.mockResolvedValue({ requiresReauthentication: true });
});

describe("identity lifecycle action boundaries", () => {
  it("closes only the server household after explicit confirmation and ends browser authentication", async () => {
    expect(await changeHouseholdMembershipAction(form({
      operation: "close", confirmed: "on", currentPassword: "current-password",
      householdId: "forged-household", userId: "another-account",
    }))).toEqual({ ok: true, data: { reauthenticate: true } });
    expect(harness.close).toHaveBeenCalledExactlyOnceWith(session, { currentPassword: "current-password", confirmed: true });
    expect(harness.signOut).not.toHaveBeenCalled();
    await finishReauthenticationAction();
    expect(harness.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/login?reason=account-updated" });
  });

  it("does not close without confirmation or sign out after a failed close", async () => {
    expect(await changeHouseholdMembershipAction(form({ operation: "close", currentPassword: "current-password" })))
      .toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.close).not.toHaveBeenCalled();
    harness.close.mockRejectedValueOnce(new IdentityError("PASSWORD_INVALID"));
    expect(await changeHouseholdMembershipAction(form({ operation: "close", confirmed: "on", currentPassword: "incorrect" })))
      .toEqual({ ok: false, code: "PASSWORD_INVALID" });
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it("allows an account-only session to deactivate only itself after service validation", async () => {
    const accountOnly = { id: session.id, appSessionId: session.appSessionId, email: session.email, name: session.name };
    harness.account.mockResolvedValueOnce(accountOnly);
    expect(await deactivateOwnAccountAction(form({
      currentPassword: "current-password", confirmed: "on", userId: "another-account", householdId: "another-household",
    }))).toEqual({ ok: true, data: { reauthenticate: true } });
    expect(harness.deactivate).toHaveBeenCalledExactlyOnceWith(accountOnly, { currentPassword: "current-password", confirmed: true });
    expect(harness.household).not.toHaveBeenCalled();
    expect(harness.signOut).not.toHaveBeenCalled();
    await finishReauthenticationAction();
    expect(harness.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/login?reason=account-updated" });
  });

  it("passes an absent confirmation as false and retains authentication when deactivation fails", async () => {
    harness.deactivate.mockRejectedValueOnce(new IdentityError("INVALID_INPUT"));
    expect(await deactivateOwnAccountAction(form({ currentPassword: "current-password" })))
      .toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.deactivate).toHaveBeenCalledWith(session, { currentPassword: "current-password", confirmed: false });
    harness.deactivate.mockRejectedValueOnce(new IdentityError("OWNER_CLOSE_REQUIRED"));
    expect(await deactivateOwnAccountAction(form({ currentPassword: "current-password", confirmed: "on" })))
      .toEqual({ ok: false, code: "OWNER_CLOSE_REQUIRED" });
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it("does not expose unexpected lifecycle errors or accept an invalid account session", async () => {
    harness.deactivate.mockRejectedValueOnce(new Error("private service detail"));
    expect(await deactivateOwnAccountAction(form({ confirmed: "on" })))
      .toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
    harness.account.mockRejectedValueOnce(new Error("Unauthorized"));
    expect(await deactivateOwnAccountAction(form({ confirmed: "on" })))
      .toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(harness.deactivate).toHaveBeenCalledTimes(1);
    expect(harness.signOut).not.toHaveBeenCalled();
  });
});
